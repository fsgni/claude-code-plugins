import type { On, SessionContextBreakdown, SessionUsage, SessionUsageArgs } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

const WINDOW = 200_000

// The icons as the meter draws them: Nerd Font code points.
const MEMORY = '\u{F035B}'
const SAND = '\u{F051F}'
const CALENDAR = '\u{F00ED}'

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

// The engine beneath the plugin: its clock, the hint line it draws, and the
// figures `$.session.usage()` reads (no fill reported, no limits, by default).
function setUp(on: On, { now, usage }: { now?: number; usage?: (args: SessionUsageArgs) => SessionUsage } = {}) {
  const clock = mock.clock(on, { now })
  const tails: (string | undefined)[] = []

  on('ui.render', { component: 'PromptHint' }, (_$, e) => {
    tails.push(e.props.tail)

    return { type: 'engine', ref: 0 }
  })
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.usage', (_$, e) => ({
    value: usage?.(e) ?? { startedAt: 0, rateLimits: [], context: { window: WINDOW } },
  }))
  on('tool.call', () => ({ result: 'ok' }))

  // What the hint line ends with when the terminal draws it now.
  async function tail($: Engine) {
    await $.ui.render({ surface: 'terminal', component: 'PromptHint', requestId: 'prompt-hint', props: HINT })

    return tails.at(-1)
  }

  return { clock, tail }
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
