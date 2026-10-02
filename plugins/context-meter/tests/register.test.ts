import type { On, SessionContextBreakdown, SessionUsage, SessionUsageArgs } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

const WINDOW = 200_000

// The icons as the row draws them: Nerd Font code points.
const CHIP = '\u{F2DB}'
const HOURGLASS = '\u{F252}'
const CALENDAR = '\u{F073}'
const SPARKLES = '\u{F0674}'
const GAUGE_LOW = '\u{F0875}'
const FIRE = '\u{F0238}'

// The band above the prompt as the terminal hands it to the plugins, less its width.
const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, scroll: { offset: 0, bodyRows: 10 }, view: {} }

// A /context breakdown with `used` tokens in use, beside rows that do not count.
function breakdown(used: number): SessionContextBreakdown {
  const buffer = 33_000

  return {
    categories: [
      { name: 'Messages', tokens: used, color: 'promptBorder', isDeferred: false, kind: 'used' },
      { name: 'MCP tools', tokens: 5_000, color: 'inactive', isDeferred: true, kind: 'deferred' },
      { name: 'Autocompact buffer', tokens: buffer, color: 'inactive', isDeferred: false, kind: 'buffer' },
      { name: 'Free space', tokens: WINDOW - used - buffer, color: 'inactive', isDeferred: false, kind: 'free' },
    ],
    totalTokens: used,
    maxTokens: WINDOW,
    rawMaxTokens: WINDOW,
    autocompactSource: 'model-default',
    percentage: Math.round((used / WINDOW) * 100),
    gridRows: [],
    model: 'claude-opus-5-5',
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    isAutoCompactEnabled: true,
    apiUsage: null,
  }
}

type World = {
  now?: number
  usage?: (args: SessionUsageArgs) => SessionUsage
  // What `$.session.model()` answers, as /model names the model.
  model?: () => string
  // What a slash command prints.
  output?: (command: string, args: string) => string
}

// The engine beneath the plugin: its clock, the band it draws when the plugin
// passes, the figures `$.session.usage()` reads (no fill reported, no limits,
// by default), the session's model, slash commands and model requests.
function setUp(on: On, { now, usage, model, output }: World = {}) {
  const clock = mock.clock(on, { now })

  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 0 }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.usage', (_$, e) => ({
    value: usage?.(e) ?? { startedAt: 0, rateLimits: [], context: { window: WINDOW } },
  }))
  on('session.model', () => ({ value: model?.() ?? 'Opus 5.5' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('command.run', (_$, e) => ({ text: output?.(e.command, e.args) ?? '' }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })

  return { clock }
}

// The text a drawn node shows, its descendants' strings in order.
function textOf(node: unknown): string {
  if (typeof node === 'string') {
    return node
  }

  const children = (node as { children?: unknown[] } | undefined)?.children ?? []

  return children.map(textOf).join('')
}

// The Box drawn with `key`, anywhere in the tree.
function partOf(node: unknown, key: string): unknown {
  if (typeof node !== 'object' || node === null) {
    return undefined
  }

  const { props, children = [] } = node as { props?: { key?: unknown }; children?: unknown[] }

  return props?.key === key ? node : children.map(child => partOf(child, key)).find(part => part !== undefined)
}

// The row as the terminal draws it `columns` wide: what each side shows, and
// the color the Text showing `text` exactly is drawn in.
async function row($: Engine, { columns = 120, hasSurvey = false } = {}) {
  const ui = await $.ui.mount({
    plugin: 'context-meter',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { ...BAND, bodyColumns: columns, hasSurvey },
  })
  const drawn = await ui.drawn()

  async function colorOf(text: string) {
    return (await ui.find({ type: 'Text', text: new RegExp(`^${text}$`) }))?.props.color
  }

  return { usage: textOf(partOf(drawn, 'usage')), model: textOf(partOf(drawn, 'model')), drawn, colorOf }
}

const start = ($: Engine) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

// A slash command the person typed at a fullscreen terminal.
const command = ($: Engine, name: string, args: string) =>
  $.command.run({
    command: name,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })

// One request of the main loop, read to its end.
async function step($: Engine, model: string, effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max') {
  const stream = $.turn.step({ turnId: 'turn', index: 0, model, effort, messageCount: 1 })

  for await (const _ of stream) {
    // the test reads the row, not the response
  }
}

const MEASURED = {
  context: { tokens: 63_000, window: WINDOW, percent: 32 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 42.5, resetsAt: '2026-10-02T15:00:00Z' },
    { kind: 'seven_day', percentUsed: 18, resetsAt: '2026-10-06T09:00:00Z' },
  ],
  changed: ['context' as const, 'rateLimits' as const],
}

test('draws the fill and the usage limits on the left of the row, the model on the right', async ($, on) => {
  setUp(on)
  await start($)

  await $.session.measure(MEASURED)
  const { usage, model, colorOf } = await row($)

  expect(usage).toBe(`${CHIP} ▰▰▰▱▱▱▱▱ 32% 63k/200k · ${HOURGLASS} ▰▰▰▱▱▱▱▱ 43% · ${CALENDAR} ▰▱▱▱▱▱▱▱ 18%`)
  expect(model).toBe(`${SPARKLES} Opus 5.5`)
  expect(await colorOf('32%')).toBe('success')
  expect(await colorOf(`${CHIP} `)).toBe('rainbow_blue')
})

test("keeps clear of the band's collapse button in its top right corner", async ($, on) => {
  setUp(on)
  await start($)
  await step($, 'claude-opus-5-5', 'max')

  const { drawn, model } = await row($)

  expect(model).toBe(`${SPARKLES} Opus 5.5  ${FIRE} max`)
  expect(drawn).toMatchObject({ type: 'Box', props: { paddingRight: 4 } })
})

test('drops the token counts, then shortens the bars, as the row narrows', async ($, on) => {
  setUp(on)
  await start($)
  await $.session.measure(MEASURED)

  expect((await row($, { columns: 70 })).usage).toBe(
    `${CHIP} ▰▰▰▱▱▱▱▱ 32% · ${HOURGLASS} ▰▰▰▱▱▱▱▱ 43% · ${CALENDAR} ▰▱▱▱▱▱▱▱ 18%`,
  )
  expect((await row($, { columns: 60 })).usage).toBe(`${CHIP} ▰▱▱▱ 32% · ${HOURGLASS} ▰▰▱▱ 43% · ${CALENDAR} ▰▱▱▱ 18%`)
  expect((await row($, { columns: 40 })).usage).toBe(`${CHIP} 32% · ${HOURGLASS} 43% · ${CALENDAR} 18%`)
})

test('colors a gauge by how full it is', async ($, on) => {
  setUp(on, {
    usage: () => ({
      startedAt: 0,
      rateLimits: [{ kind: 'five_hour', percentUsed: 85 }],
      context: { tokens: 150_000, window: WINDOW },
    }),
  })
  await start($)

  await $.tool.call({ tool: 'Bash', command: 'echo hi' })
  const { usage, colorOf } = await row($)

  expect(usage).toBe(`${CHIP} ▰▰▰▰▰▰▱▱ 75% 150k/200k · ${HOURGLASS} ▰▰▰▰▰▰▰▱ 85%`)
  expect(await colorOf('75%')).toBe('warning')
  expect(await colorOf('85%')).toBe('error')
})

test('estimates the fill after /clear, until a response reports one', async ($, on) => {
  let tokens: number | undefined = 150_000
  const { clock } = setUp(on, {
    usage: args => ({
      startedAt: 0,
      rateLimits: [],
      context: { tokens, window: WINDOW, breakdown: args.breakdown ? breakdown(18_000) : undefined },
    }),
  })
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'echo hi' })

  tokens = undefined
  await $.session.end({ reason: 'clear', sessionId: 'before', resume: { id: 'before' } })
  await clock.advance(300)

  expect((await row($)).usage).toBe(`${CHIP} ▰▱▱▱▱▱▱▱ ~9% ~18k/200k`)
})

test('empties a usage window once it has reset', async ($, on) => {
  const reading = {
    context: { tokens: 63_000, window: WINDOW },
    rateLimits: [{ kind: 'five_hour', percentUsed: 97, resetsAt: '2026-10-02T15:00:30Z' }],
  }
  const { clock } = setUp(on, {
    now: Date.parse('2026-10-02T15:00:00Z'),
    usage: () => ({ startedAt: 0, ...reading }),
  })
  await start($)

  await $.session.measure({ ...reading, changed: ['context', 'rateLimits'] })
  expect((await row($)).usage).toBe(`${CHIP} ▰▰▰▱▱▱▱▱ 32% 63k/200k · ${HOURGLASS} ▰▰▰▰▰▰▰▰ 97%`)

  await clock.advance(60_000)
  expect((await row($)).usage).toBe(`${CHIP} ▰▰▰▱▱▱▱▱ 32% 63k/200k · ${HOURGLASS} ▱▱▱▱▱▱▱▱ 0%`)
})

test('names the model and its effort as each request names them', async ($, on) => {
  setUp(on)
  await start($)

  await step($, 'claude-opus-5-5[1m]', 'max')
  const maxed = await row($)
  expect(maxed.model).toBe(`${SPARKLES} Opus 5.5  ${FIRE} max`)
  expect(await maxed.colorOf('max')).toBe('effortUltra')

  await step($, 'claude-haiku-4-5-20251001')
  expect((await row($)).model).toBe(`${SPARKLES} Haiku 4.5`)
})

test('shows the effort /effort set before the next request', async ($, on) => {
  setUp(on, {
    output: (name, args) => (name === 'effort' && args === '' ? 'Set effort level to medium (this session only)' : ''),
  })
  await start($)
  await step($, 'claude-opus-5-5', 'max')

  await command($, 'effort', '')
  expect((await row($)).model).toBe(`${SPARKLES} Opus 5.5  ${GAUGE_LOW} medium`)
})

test('reads the model /model chose and leaves the effort to the next request', async ($, on) => {
  let model = 'Opus 5.5'
  setUp(on, { model: () => model })
  await start($)
  await step($, 'claude-opus-5-5', 'max')

  model = 'Sonnet 5.5'
  await command($, 'model', 'sonnet')

  expect((await row($)).model).toBe(`${SPARKLES} Sonnet 5.5`)
})

test('leaves the band to a survey', async ($, on) => {
  setUp(on)
  await start($)
  await $.session.measure(MEASURED)

  expect((await row($, { hasSurvey: true })).drawn).toEqual({ type: 'engine', ref: 0 })
})

test('draws nothing in a run with nobody at the prompt', async ($, on) => {
  setUp(on)
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
  await $.session.measure(MEASURED)

  expect((await row($)).drawn).toEqual({ type: 'engine', ref: 0 })
})
