import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  Register,
  SessionContextBreakdown,
  SessionContextUsage,
  SessionRateLimit,
} from 'claude-code'

import type { MeterGauge, MeterGauges, MeterModel } from '../types'

// What the row above the prompt draws: usage gauges on the left, the model and
// its effort on the right.
const gauges = atom({ plugin: 'context-meter', key: 'gauges' } as const, null)
const modelEffort = atom({ plugin: 'context-meter', key: 'modelEffort' } as const, null)

// How long after /clear, /compact or a resume to measure again, once it settled.
const SETTLE_MS = 300

// How often to redraw while idle, so a usage window that reset shows as empty.
const TICK_MS = 60_000

// Nerd Font icons (Cascadia Mono NF draws them) and the theme colors they take.
type Look = { icon: string; color: string }

const GAUGE_LOOKS: Record<string, Look> = {
  context: { icon: '\u{F2DB}', color: 'rainbow_blue' }, // nf-fa-microchip
  five_hour: { icon: '\u{F252}', color: 'rainbow_indigo' }, // nf-fa-hourglass_half
  seven_day: { icon: '\u{F073}', color: 'rainbow_violet' }, // nf-fa-calendar
  spend_limit: { icon: '\u{F09D}', color: 'rainbow_green' }, // nf-fa-credit_card
}
const OTHER_GAUGE: Look = { icon: '\u{F080}', color: 'subtle' } // nf-fa-bar_chart

const MODEL_LOOK: Look = { icon: '\u{F0674}', color: 'claude' } // nf-md-creation

// The gauge fills up with the effort, and catches fire at max.
const EFFORT_LOOKS: Record<string, Look> = {
  low: { icon: '\u{F0873}', color: 'success' }, // nf-md-gauge_empty
  medium: { icon: '\u{F0875}', color: 'rainbow_yellow' }, // nf-md-gauge_low
  high: { icon: '\u{F029A}', color: 'rainbow_orange' }, // nf-md-gauge
  xhigh: { icon: '\u{F0874}', color: 'rainbow_red' }, // nf-md-gauge_full
  max: { icon: '\u{F0238}', color: 'effortUltra' }, // nf-md-fire
}
const OTHER_EFFORT: Look = { icon: '\u{F029A}', color: 'subtle' }

// The band draws its collapse button, `[-]`, over its top right corner: the
// row keeps those columns and one more clear.
const COLLAPSE_COLUMNS = 4

// How much the gauges show, richest first: as the row narrows, the token
// counts go, then the bars shorten, then the bars go.
const DENSITIES = [
  { cells: 8, hasDetail: true },
  { cells: 8, hasDetail: false },
  { cells: 4, hasDetail: false },
  { cells: 0, hasDetail: false },
] as const

// The effort level `/effort` was given, or the one its output says it set.
const EFFORT_ARG = /^\s*(low|medium|high|xhigh|max)\b/i
const EFFORT_SET = /\bto (low|medium|high|xhigh|max)\b/i

type Fill = { used: number; window: number; isEstimate: boolean }
type Reading = { context: SessionContextUsage; rateLimits: readonly SessionRateLimit[] }

// A run of text in one style; the row is drawn from these.
type Piece = { text: string; color?: string; isDim?: boolean }

// What the row is drawn from, one per load of the module.
type Meter = {
  isInteractive: boolean
  isTicking: boolean
  fill: Fill | undefined
  limits: readonly SessionRateLimit[]
  // Bumped by every fill reading, so a slow estimate never overwrites a newer one.
  fillSeq: number
  // The main loop's model and effort, as its latest request named them.
  model: string | undefined
  effort: string | undefined
  // What was last written to each value, as JSON; undefined until this load wrote it.
  gaugesShown: string | undefined
  modelShown: string | undefined
}

// 63_000 → "63k", 1_000_000 → "1M"
function count(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${Number((tokens / 1_000_000).toFixed(1))}M`
  }

  return tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : String(tokens)
}

// What occupies the window, as /context counts it: not the free space, the
// compaction reserve or the tool schemas loaded on demand.
function usedTokens(breakdown: SessionContextBreakdown): number {
  return breakdown.categories
    .filter(row => row.kind === 'used')
    .reduce((sum, row) => sum + row.tokens, 0)
}

// "claude-opus-5-5[1m]" → "Opus 5.5", "claude-haiku-4-5-20251001" → "Haiku 4.5"
function modelName(model: string): string {
  const match = /(opus|sonnet|haiku|fable)(?:[-\s]+(\d+)(?:[-.](\d{1,2})(?!\d))?)?/i.exec(model)
  const family = match?.[1]

  if (match === null || family === undefined) {
    return model
  }

  const version = [match[2], match[3]].filter(part => part !== undefined).join('.')

  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()}${version === '' ? '' : ` ${version}`}`
}

// Only the icons take color: the bar stays dim and the figures plain, so the
// row never outshouts the prompt's own footer.
function gaugePieces(gauge: MeterGauge, cells: number, hasDetail: boolean): Piece[] {
  const look = GAUGE_LOOKS[gauge.kind] ?? OTHER_GAUGE
  const about = gauge.isEstimate ? '~' : ''
  const pieces: Piece[] = [{ text: `${look.icon} `, color: look.color }]

  if (cells > 0) {
    const filled = Math.max(0, Math.min(cells, Math.round((gauge.percent / 100) * cells)))
    pieces.push({ text: `${'▰'.repeat(filled)}${'▱'.repeat(cells - filled)} `, isDim: true })
  }

  pieces.push({ text: `${about}${gauge.percent}%` })

  if (hasDetail && gauge.detail !== null) {
    pieces.push({ text: ` ${about}${gauge.detail}`, isDim: true })
  }

  return pieces
}

function usagePieces(list: readonly MeterGauge[], cells: number, hasDetail: boolean): Piece[] {
  return list.flatMap((gauge, index) => [
    ...(index > 0 ? [{ text: ' · ', isDim: true }] : []),
    ...gaugePieces(gauge, cells, hasDetail),
  ])
}

function modelPieces(value: MeterModel): Piece[] {
  if (value === null) {
    return []
  }

  const pieces: Piece[] = [{ text: `${MODEL_LOOK.icon} `, color: MODEL_LOOK.color }, { text: modelName(value.model) }]

  if (value.effort !== null) {
    const look = EFFORT_LOOKS[value.effort] ?? OTHER_EFFORT
    pieces.push({ text: `  ${look.icon} `, color: look.color }, { text: value.effort })
  }

  return pieces
}

function widthOf(pieces: readonly Piece[]): number {
  return pieces.reduce((sum, piece) => sum + [...piece.text].length, 0)
}

// A piece's Text props, leaving out what it does not set.
function styleOf(piece: Piece) {
  return {
    ...(piece.color !== undefined && { color: piece.color }),
    ...(piece.isDim === true && { dimColor: true }),
  }
}

async function paintGauges($: EngineInterface, meter: Meter) {
  const now = await $.clock.now()
  const list: MeterGauge[] = []

  if (meter.fill !== undefined) {
    const { used, window, isEstimate } = meter.fill

    list.push({
      kind: 'context',
      percent: window > 0 ? Math.round((used / window) * 100) : 0,
      isEstimate,
      detail: `${count(used)}/${count(window)}`,
    })
  }

  for (const limit of meter.limits) {
    const hasReset = limit.resetsAt !== undefined && Date.parse(limit.resetsAt) <= now

    list.push({
      kind: limit.kind,
      percent: hasReset ? 0 : Math.round(limit.percentUsed),
      isEstimate: false,
      detail: null,
    })
  }

  const value: MeterGauges = list.length > 0 ? list : null
  const shown = JSON.stringify(value)

  if (shown !== meter.gaugesShown) {
    meter.gaugesShown = shown
    await update($, gauges, () => value)
  }
}

async function paintModel($: EngineInterface, meter: Meter) {
  if (!meter.isInteractive) {
    return
  }

  const value: MeterModel = meter.model === undefined ? null : { model: meter.model, effort: meter.effort ?? null }
  const shown = JSON.stringify(value)

  if (shown !== meter.modelShown) {
    meter.modelShown = shown
    await update($, modelEffort, () => value)
  }
}

// Reads the figures (or takes the ones the engine pushed) and redraws. Until a
// response reports the window's fill (a new session, after /clear or /compact)
// the fill is estimated the way /context does, unless the caller only wants
// the cheap read.
async function refresh(
  $: EngineInterface,
  meter: Meter,
  { reading, canEstimate = true }: { reading?: Reading; canEstimate?: boolean } = {},
) {
  if (!meter.isInteractive) {
    return
  }

  try {
    const { context, rateLimits } = reading ?? (await $.session.usage())
    meter.limits = rateLimits

    if (context.tokens !== undefined) {
      meter.fillSeq += 1
      meter.fill = { used: context.tokens, window: context.window, isEstimate: false }
    } else if (canEstimate) {
      const seq = ++meter.fillSeq
      const { breakdown } = (await $.session.usage({ breakdown: 'summary' })).context

      if (seq === meter.fillSeq) {
        meter.fill = breakdown && { used: usedTokens(breakdown), window: context.window, isEstimate: true }
      }
    }

    await paintGauges($, meter)
  } catch (error) {
    $.ui.log(`refresh failed: ${String(error)}`, { to: 'debug' })
  }
}

function later($: EngineInterface, meter: Meter) {
  $.clock.after(SETTLE_MS, () => void refresh($, meter))
}

// The main loop's model as /model names it: before the first request, and
// after /model changed it.
async function learnModel($: EngineInterface, meter: Meter) {
  try {
    meter.model = await $.session.model()
    await paintModel($, meter)
  } catch (error) {
    $.ui.log(`model read failed: ${String(error)}`, { to: 'debug' })
  }
}

export const register: Register = on => {
  const meter: Meter = {
    isInteractive: false,
    isTicking: false,
    fill: undefined,
    limits: [],
    fillSeq: 0,
    model: undefined,
    effort: undefined,
    gaugesShown: undefined,
    modelShown: undefined,
  }

  on('session.start', async ($, e, next) => {
    meter.isInteractive = e.isInteractive

    if (meter.isInteractive) {
      later($, meter)

      if (!meter.isTicking) {
        meter.isTicking = true
        $.clock.every(TICK_MS, () => void refresh($, meter, { canEstimate: false }))
      }

      // A reload keeps the session's values: the effort last seen stands until
      // the next request names one.
      meter.effort = (await read($, modelEffort))?.effort ?? undefined
      await learnModel($, meter)
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = (await read($, gauges)) ?? []
    const right = modelPieces(await read($, modelEffort))

    if (e.props.hasSurvey || (list.length === 0 && right.length === 0)) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const room = e.props.bodyColumns - COLLAPSE_COLUMNS - widthOf(right) - (right.length > 0 ? 2 : 0)
    const left =
      DENSITIES.map(({ cells, hasDetail }) => usagePieces(list, cells, hasDetail)).find(
        pieces => widthOf(pieces) <= room,
      ) ?? usagePieces(list, 0, false)
    const draw = (pieces: readonly Piece[]) =>
      pieces.filter(piece => piece.text !== '').map(piece => <Text {...styleOf(piece)}>{piece.text}</Text>)

    return (
      <Box flexDirection="row" paddingRight={COLLAPSE_COLUMNS}>
        <Box key="usage" flexGrow={1} flexShrink={1} overflow="hidden">
          {left.length > 0 && <Text wrap="truncate">{draw(left)}</Text>}
        </Box>
        {right.length > 0 && (
          <Box key="model" flexShrink={0} marginLeft={2}>
            <Text>{draw(right)}</Text>
          </Box>
        )}
      </Box>
    )
  })

  // Every request of the main loop names its model and effort.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      meter.model = e.model
      meter.effort = e.effort === undefined ? undefined : String(e.effort)
      await paintModel($, meter)
    }

    return yield* next(e)
  })

  // /effort takes effect before the next request: show the level it set.
  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const ran = await next(e)
    const level = EFFORT_ARG.exec(e.args)?.[1] ?? EFFORT_SET.exec(ran.text ?? '')?.[1]

    if (level !== undefined) {
      meter.effort = level.toLowerCase()
      await paintModel($, meter)
    }

    return ran
  })

  // /model changes the model now; its effort shows with the next request.
  on('command.run', { command: 'model' }, async ($, e, next) => {
    const ran = await next(e)
    meter.effort = undefined
    await learnModel($, meter)

    return ran
  })

  // The engine pushes its figures after every main-thread turn.
  on('session.measure', async ($, e, next) => {
    await refresh($, meter, { reading: e })

    return next(e)
  })

  // A tool call follows a model response, so a long turn updates as it runs.
  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) {
      await refresh($, meter, { canEstimate: false })
    }

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const compacted = await next(e)

    if (e.trigger !== 'precompute' && e.agentId === undefined) {
      later($, meter)
    }

    return compacted
  })

  on('session.end', async ($, e, next) => {
    const ended = await next(e)

    if (e.reason === 'clear' || e.reason === 'resume') {
      later($, meter)
    }

    return ended
  })
}
