import type { On, SessionContextBreakdown, SessionUsage, SessionUsageArgs } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

const WINDOW = 200_000

// The icons as the meter draws them: Nerd Font code points.
const MEMORY = '\u{F035B}'
const SAND = '\u{F051F}'
const CALENDAR = '\u{F00ED}'
const ROBOT = '\u{F06A9}'
const GAUGE = '\u{F04C5}'

// The hint line under an empty prompt, as the engine hands it to the plugins.
const HINT = { isDraft: false, isWorking: false, hint: '? for shortcuts' }

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

// The engine beneath the plugin: its clock, the hint line and mode labels it
// draws, the figures `$.session.usage()` reads (no fill reported, no limits,
// by default), the session's model, slash commands and model requests.
function setUp(on: On, { now, usage, model, output }: World = {}) {
  const clock = mock.clock(on, { now })
  const tails: (string | undefined)[] = []
  const modes: (readonly string[])[] = []

  on('ui.render', { component: 'PromptHint' }, (_$, e) => {
    tails.push(e.props.tail)

    return { type: 'engine', ref: 0 }
  })
  on('ui.render', { component: 'SessionMode' }, (_$, e) => {
    modes.push(e.props.modes)

    return { type: 'engine', ref: 0 }
  })
  on('ui.status', () => ({ value: undefined }))
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

  // What the hint line ends with when the terminal draws it now.
  async function tail($: Engine) {
    await $.ui.render({ surface: 'terminal', component: 'PromptHint', requestId: 'prompt-hint', props: HINT })

    return tails.at(-1)
  }

  // The mode labels the terminal draws at the right of the footer now.
  async function footer($: Engine) {
    await $.ui.render({ surface: 'terminal', component: 'SessionMode', requestId: 'session-mode', props: { modes: [] } })

    return modes.at(-1)
  }

  return { clock, tail, footer }
}

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
    // the test reads the labels, not the response
  }
}

const start = ($: Engine) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

test('ends the hint line with the fill and the usage limits measured after a turn', async ($, on) => {
  const { tail } = setUp(on)
  await start($)

  await $.session.measure({
    context: { tokens: 63_000, window: WINDOW, percent: 32 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 42.5, resetsAt: '2026-10-02T15:00:00Z' },
      { kind: 'seven_day', percentUsed: 18, resetsAt: '2026-10-06T09:00:00Z' },
    ],
    changed: ['context', 'rateLimits'],
  })

  expect(await tail($)).toBe(`${MEMORY} ▰▰▰▱▱▱▱▱ 32% 63k/200k · ${SAND} ▰▰▰▱▱▱▱▱ 43% · ${CALENDAR} ▰▱▱▱▱▱▱▱ 18%`)
})

test('updates at each tool call of a turn, then estimates the fill after /clear', async ($, on) => {
  let tokens: number | undefined = 150_000
  const { clock, tail } = setUp(on, {
    usage: args => ({
      startedAt: 0,
      rateLimits: [],
      context: { tokens, window: WINDOW, breakdown: args.breakdown ? breakdown(18_000) : undefined },
    }),
  })
  await start($)

  await $.tool.call({ tool: 'Bash', command: 'echo hi' })
  expect(await tail($)).toBe(`${MEMORY} ▰▰▰▰▰▰▱▱ 75% 150k/200k`)

  tokens = undefined
  await $.session.end({ reason: 'clear', sessionId: 'before', resume: { id: 'before' } })
  await clock.advance(300)

  expect(await tail($)).toBe(`${MEMORY} ▰▱▱▱▱▱▱▱ ~9% ~18k/200k`)
})

test('empties a usage window once it has reset', async ($, on) => {
  const reading = {
    context: { tokens: 63_000, window: WINDOW },
    rateLimits: [{ kind: 'five_hour', percentUsed: 97, resetsAt: '2026-10-02T15:00:30Z' }],
  }
  const { clock, tail } = setUp(on, {
    now: Date.parse('2026-10-02T15:00:00Z'),
    usage: () => ({ startedAt: 0, ...reading }),
  })
  await start($)

  await $.session.measure({ ...reading, changed: ['context', 'rateLimits'] })
  expect(await tail($)).toBe(`${MEMORY} ▰▰▰▱▱▱▱▱ 32% 63k/200k · ${SAND} ▰▰▰▰▰▰▰▰ 97%`)

  await clock.advance(60_000)
  expect(await tail($)).toBe(`${MEMORY} ▰▰▰▱▱▱▱▱ 32% 63k/200k · ${SAND} ▱▱▱▱▱▱▱▱ 0%`)
})

test('leaves the hint line alone in a run with nobody at the prompt', async ($, on) => {
  const { tail } = setUp(on)
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false })

  await $.session.measure({ context: { tokens: 63_000, window: WINDOW }, rateLimits: [], changed: ['context'] })

  expect(await tail($)).toBeUndefined()
})

test('names the model and its effort after the footer modes, as each request names them', async ($, on) => {
  const { footer } = setUp(on)
  await start($)
  expect(await footer($)).toEqual([`${ROBOT} Opus 5.5`])

  await step($, 'claude-opus-5-5[1m]', 'max')
  expect(await footer($)).toEqual([`${ROBOT} Opus 5.5 ${GAUGE} max`])

  await step($, 'claude-haiku-4-5-20251001')
  expect(await footer($)).toEqual([`${ROBOT} Haiku 4.5`])
})

test('shows the effort /effort set before the next request', async ($, on) => {
  const { footer } = setUp(on, {
    output: (command, args) => (command === 'effort' && args === '' ? 'Set effort level to xhigh (this session only)' : ''),
  })
  await start($)
  await step($, 'claude-opus-5-5', 'max')

  await command($, 'effort', 'high')
  expect(await footer($)).toEqual([`${ROBOT} Opus 5.5 ${GAUGE} high`])

  await command($, 'effort', '')
  expect(await footer($)).toEqual([`${ROBOT} Opus 5.5 ${GAUGE} xhigh`])
})

test('reads the model /model chose and leaves the effort to the next request', async ($, on) => {
  let model = 'Opus 5.5'
  const { footer } = setUp(on, { model: () => model })
  await start($)
  await step($, 'claude-opus-5-5', 'max')

  model = 'Sonnet 5.5'
  await command($, 'model', 'sonnet')

  expect(await footer($)).toEqual([`${ROBOT} Sonnet 5.5`])
})
