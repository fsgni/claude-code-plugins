import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  Register,
  SessionContextBreakdown,
  SessionContextUsage,
  SessionRateLimit,
} from 'claude-code'

import type { MeterLine } from '../types'

// What the hint line under the prompt ends with.
const line = atom({ plugin: 'context-meter', key: 'line' } as const, null)

// Cells in each bar: ▰ used, ▱ left.
const CELLS = 8

// How long after /clear, /compact or a resume to measure again, once it settled.
const SETTLE_MS = 300

// How often to redraw while idle, so a usage window that reset shows as empty.
const TICK_MS = 60_000

// Nerd Font icons: the terminal draws them with a Nerd Font (Cascadia Mono NF).
const CONTEXT_ICON = '\u{F035B}' // nf-md-memory
const LIMIT_ICONS: Record<string, string> = {
  five_hour: '\u{F051F}', // nf-md-timer_sand
  seven_day: '\u{F00ED}', // nf-md-calendar
  spend_limit: '\u{F09D}', // nf-fa-credit_card
}
const OTHER_LIMIT_ICON = '\u{F080}' // nf-fa-bar_chart

type Fill = { used: number; window: number; isEstimate: boolean }
type Reading = { context: SessionContextUsage; rateLimits: readonly SessionRateLimit[] }

// What the meter is drawn from, one per load of the module.
type Meter = {
  isInteractive: boolean
  isTicking: boolean
  fill: Fill | undefined
  limits: readonly SessionRateLimit[]
  // Bumped by every fill reading, so a slow estimate never overwrites a newer one.
  fillSeq: number
  // The line last written; undefined until this load wrote one.
  shown: MeterLine | undefined
}

function bar(percent: number): string {
  const filled = Math.max(0, Math.min(CELLS, Math.round((percent / 100) * CELLS)))

  return '▰'.repeat(filled) + '▱'.repeat(CELLS - filled)
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

async function paint($: EngineInterface, meter: Meter) {
  const now = await $.clock.now()
  const parts: string[] = []

  if (meter.fill !== undefined) {
    const { used, window, isEstimate } = meter.fill
    const percent = window > 0 ? Math.round((used / window) * 100) : 0
    const about = isEstimate ? '~' : ''

    parts.push(`${CONTEXT_ICON} ${bar(percent)} ${about}${percent}% ${about}${count(used)}/${count(window)}`)
  }

  for (const limit of meter.limits) {
    const hasReset = limit.resetsAt !== undefined && Date.parse(limit.resetsAt) <= now
    const percent = hasReset ? 0 : Math.round(limit.percentUsed)

    parts.push(`${LIMIT_ICONS[limit.kind] ?? OTHER_LIMIT_ICON} ${bar(percent)} ${percent}%`)
  }

  const text = parts.length > 0 ? parts.join(' · ') : null

  if (text !== meter.shown) {
    meter.shown = text
    await update($, line, () => text)
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

    await paint($, meter)
  } catch (error) {
    $.ui.log(`refresh failed: ${String(error)}`, { to: 'debug' })
  }
}

function later($: EngineInterface, meter: Meter) {
  $.clock.after(SETTLE_MS, () => void refresh($, meter))
}

export const register: Register = on => {
  const meter: Meter = {
    isInteractive: false,
    isTicking: false,
    fill: undefined,
    limits: [],
    fillSeq: 0,
    shown: undefined,
  }

  on('session.start', ($, e, next) => {
    meter.isInteractive = e.isInteractive

    if (meter.isInteractive) {
      // 0.1.0 drew on the status line; the meter lives on the hint line now.
      $.ui.status(undefined)
      later($, meter)

      if (!meter.isTicking) {
        meter.isTicking = true
        $.clock.every(TICK_MS, () => void refresh($, meter, { canEstimate: false }))
      }
    }

    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const text = await read($, line)

    return text === null ? next(e) : next({ ...e, props: { ...e.props, tail: text } })
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
