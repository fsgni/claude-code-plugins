import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import type { BoardCard, BoardLine, BoardScreen } from '../types'

const HOME = 'C:/Users/me'
const SESSIONS = `${HOME}/.claude/sessions`
const CARDS = `${HOME}/.claude/role-board/cards`
const SCREENS = `${HOME}/.claude/role-board/screens`
const GAME = 'C:\\Projects\\mygame'
const TOOLS = 'C:\\Projects\\tools'

const T0 = Date.parse('2026-10-08T10:00:00Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// The icons as the board draws them: Nerd Font code points.
const FOLDER = '\u{F07C}'
const SPINNER = '\u{F110}'
const BELL = '\u{F0F3}'
const CHECK = '\u{F00C}'
const CIRCLE = '\u{F10C}'

// The pane as the fullscreen terminal docks it beside the transcript.
const PANE_PROPS = {
  title: '职责',
  isFocused: false,
  bodyColumns: 34,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

// A conversation as Claude Code registers it while it runs.
type Session = {
  pid: number
  sessionId: string
  cwd: string
  name: string
  nameSource?: 'derived' | 'auto' | 'user'
  status: 'busy' | 'idle' | 'waiting'
  waitingFor?: string
  statusUpdatedAt: number
  startedAt: number
}

const SELF: Session = {
  pid: 31516,
  sessionId: 'self',
  cwd: GAME,
  name: '战斗程序',
  nameSource: 'user',
  status: 'idle',
  statusUpdatedAt: T0,
  startedAt: T0 - 3 * HOUR,
}
const LEVEL: Session = {
  pid: 1724,
  sessionId: 'level',
  cwd: GAME,
  name: '关卡策划',
  nameSource: 'user',
  status: 'busy',
  statusUpdatedAt: T0,
  startedAt: T0 - 2 * HOUR,
}
const LEVEL_CARD: BoardCard = {
  sessionId: 'level',
  cwd: GAME,
  beatAt: T0,
  task: { text: '发布 0.2 版本', at: T0 - MINUTE },
  doing: { tool: 'Bash', text: '跑 git push', at: T0 },
  turnAt: T0 - MINUTE,
  done: null,
}

type World = {
  sessionId?: string
  // Whether the session runs in Windows Terminal.
  isTerminal?: boolean
  // What `wt.exe` exits with.
  splitCode?: number
  // How long a tool call takes to answer.
  toolMs?: number
}

// A path as the engine hands it to the file system's hooks on Windows.
const pathOf = (path: string) => path.replace(/\//g, '\\')
const folderOf = (path: string) => path.slice(0, path.lastIndexOf('\\'))

// The machine beneath the plugin: the files it reads and writes, the
// processes running, and what the person is shown (toasts, panes, splits).
function setUp(on: On, { sessionId = 'self', isTerminal = true, splitCode = 0, toolMs = 0 }: World = {}) {
  const clock = mock.clock(on, { now: T0 })
  const files = new Map<string, { text: string; mtimeMs: number }>()
  const running = new Set<number>()
  const reads: string[] = []
  const toasts: string[] = []
  const opened: string[] = []
  const splits: (readonly string[])[] = []
  const open = new Set<string>()
  let id = sessionId
  let writes = 0

  mock.env(on, { USERPROFILE: HOME, OS: 'Windows_NT', ...(isTerminal && { WT_SESSION: 'a1b2c3' }) })

  function put(path: string, text: string) {
    writes += 1
    files.set(pathOf(path), { text, mtimeMs: clock.now() + writes })
  }

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: id }))
  on('session.cwd', () => ({ value: GAME }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('fs.list', (_$, e) => ({
    value: [...files]
      .filter(([path]) => folderOf(path) === pathOf(e.path))
      .map(([path, file]) => ({
        name: path.slice(path.lastIndexOf('\\') + 1),
        kind: 'file' as const,
        size: file.text.length,
        mtimeMs: file.mtimeMs,
        isLink: false,
      })),
  }))
  on('fs.read', (_$, e) => {
    reads.push(e.path)
    const file = files.get(pathOf(e.path))

    if (file === undefined) {
      throw new Error(`ENOENT: ${e.path}`)
    }

    return { value: file.text }
  })
  on('fs.write', (_$, e) => {
    put(e.path, e.text)

    return { value: undefined }
  })
  // The plugin's own files are there.
  on('fs.exists', (_$, e) => ({ value: e.path.endsWith('board.ps1') || files.has(pathOf(e.path)) }))
  // tasklist: the sessions running, and a process that took a dead one's pid.
  // wt.exe: a split the terminal makes.
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'wt.exe') {
      splits.push(e.argv)

      return {
        value: { exitCode: splitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
      }
    }

    const stdout = [
      ...[...running].map(pid => `"claude.exe","${pid}","Console","1","200,000 K"`),
      '"node_repl.exe","10000","Console","1","8,944 K"',
    ].join('\r\n')

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    open.add(e.id)

    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_$, e) => {
    open.delete(e.id)

    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...open].map(pane => ({ id: pane, title: '职责', isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', { component: 'Pane' }, () => ({ type: 'engine', ref: 0 }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.call', async () => {
    await clock.sleep(toolMs)

    return { result: 'ok' }
  })

  return {
    clock,
    reads,
    toasts,
    opened,
    splits,
    // Registers a conversation, running unless it crashed long ago.
    register(session: Session, { isRunning = true } = {}) {
      put(`${SESSIONS}/${session.pid}.json`, JSON.stringify({ kind: 'interactive', ...session }))
      put(`${SESSIONS}/${session.pid}.key`, 'secret')

      if (isRunning) {
        running.add(session.pid)
      }
    },
    card(held: BoardCard) {
      put(`${CARDS}/${held.sessionId}.json`, JSON.stringify(held))
    },
    cardOf(sessionId: string): BoardCard | undefined {
      const file = files.get(pathOf(`${CARDS}/${sessionId}.json`))

      return file === undefined ? undefined : (JSON.parse(file.text) as BoardCard)
    },
    // The screen a terminal pane draws, as written for board `id`.
    screenOf(boardId = 'self'): BoardScreen | undefined {
      const file = files.get(pathOf(`${SCREENS}/${boardId}.json`))

      return file === undefined ? undefined : (JSON.parse(file.text) as BoardScreen)
    },
    // /clear goes on under a new id.
    renew(next: string) {
      id = next
    },
  }
}

// A line's text: its left part, then `|` and its right part.
function textOf(line: BoardLine): string {
  const left = line.left.map(span => span.text).join('')

  return line.right === undefined ? left : `${left}|${line.right.map(span => span.text).join('')}`
}

// The text a drawn node shows, its descendants' strings in order.
function drawnText(node: unknown): string {
  if (typeof node === 'string') {
    return node
  }

  const children = (node as { children?: unknown[] } | undefined)?.children ?? []

  return children.map(drawnText).join('')
}

const start = ($: Engine) => $.session.start({ cwd: GAME, surface: 'terminal', isInteractive: true })

// /board, typed at a fullscreen terminal.
const openBoard = ($: Engine) =>
  $.command.run({
    command: 'board',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

test("lists this folder's conversations by the roles they were named", async ($, on) => {
  const world = setUp(on)
  world.register({ ...SELF, status: 'busy' })
  world.register({ ...LEVEL, status: 'waiting', waitingFor: 'dialog open', statusUpdatedAt: T0 - 5 * MINUTE })
  world.register({
    pid: 10144,
    sessionId: 'auto',
    cwd: `${GAME}\\`,
    name: 'mygame-64',
    nameSource: 'derived',
    status: 'idle',
    statusUpdatedAt: T0 - 12 * MINUTE,
    startedAt: T0 - HOUR,
  })
  // Its session does not run the plugin: no card.
  world.register({
    pid: 7328,
    sessionId: 'art',
    cwd: GAME,
    name: '美术资源',
    nameSource: 'user',
    status: 'busy',
    statusUpdatedAt: T0 - 2 * MINUTE,
    startedAt: T0 - 30 * MINUTE,
  })
  world.register({
    pid: 25504,
    sessionId: 'tools',
    cwd: TOOLS,
    name: 'tools-4e',
    nameSource: 'derived',
    status: 'busy',
    statusUpdatedAt: T0,
    startedAt: T0,
  })
  // It crashed two weeks ago, and its pid runs something else now.
  world.register(
    { pid: 10000, sessionId: 'gone', cwd: GAME, name: '旧对话', status: 'busy', statusUpdatedAt: T0 - 14 * DAY, startedAt: T0 - 14 * DAY },
    { isRunning: false },
  )
  world.card({ ...LEVEL_CARD, turnAt: T0 - 6 * MINUTE })
  world.card({
    sessionId: 'auto',
    cwd: GAME,
    beatAt: T0,
    task: { text: '改伤害公式', at: T0 - 20 * MINUTE },
    doing: null,
    turnAt: null,
    done: { text: '已把伤害公式改成乘法', at: T0 - 12 * MINUTE, outcome: 'answer' },
  })
  await start($)
  await world.clock.settle()

  expect((await openBoard($)).text).toBe('职责面板已在右侧分屏打开，在面板里按 q 关闭。')
  const screen = world.screenOf()

  expect(screen?.lines.map(textOf)).toEqual([
    `${FOLDER} mygame  4 个对话`,
    '',
    `${SPINNER} 战斗程序 · 这里|<1m`,
    '  思考中',
    '',
    `${BELL} 关卡策划|5m`,
    '  等你批准 · 跑 git push',
    '  ▸ 发布 0.2 版本',
    '',
    `${CHECK} mygame-64|12m`,
    '  已把伤害公式改成乘法',
    '  ▸ 改伤害公式',
    '',
    `${SPINNER} 美术资源|2m`,
    '  工作中',
    '',
    '其他文件夹',
    `${SPINNER} tools-4e · tools`,
  ])
  expect(screen?.lines[5]?.left).toEqual([
    { text: `${BELL} `, tone: 'warning' },
    { text: '关卡策划', tone: 'strong' },
  ])
  expect(screen?.lines[6]?.left).toEqual([{ text: '  等你批准 · 跑 git push', tone: 'warning' }])
  expect(screen?.lines[9]?.left[1]).toEqual({ text: 'mygame-64', tone: 'muted' })
  expect(world.reads.filter(path => path.endsWith('.key'))).toEqual([])
})

test('splits the terminal: the board on the right, the focus back on the left', async ($, on) => {
  const world = setUp(on)
  world.register(SELF)
  await start($)

  await openBoard($)
  const [argv] = world.splits

  expect(argv?.slice(0, 13)).toEqual([
    'wt.exe',
    '-w',
    '0',
    'split-pane',
    '-V',
    '--size',
    '0.3',
    'powershell.exe',
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
  ])
  expect(argv?.[13]?.endsWith('\\board\\board.ps1')).toBe(true)
  expect(argv?.slice(14)).toEqual(['-Screen', pathOf(`${SCREENS}/self.json`), ';', 'move-focus', 'left'])
  expect(world.opened).toEqual([])
})

test('keeps the board up to date, and closes it with the conversation', async ($, on) => {
  const world = setUp(on)
  world.register(SELF)
  world.register(LEVEL)
  world.card(LEVEL_CARD)
  await start($)
  await world.clock.settle()
  await openBoard($)
  expect(world.screenOf()?.lines.map(textOf)).toContain('  跑 git push')

  world.register({ ...LEVEL, status: 'waiting', waitingFor: 'dialog open', statusUpdatedAt: T0 + 1_000 })
  await world.clock.advance(2_000)
  expect(world.screenOf()?.lines.map(textOf)).toContain('  等你批准 · 跑 git push')
  expect(world.screenOf()?.ended).toBe(false)

  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'self', resume: { id: 'self' } })
  expect(world.screenOf()?.ended).toBe(true)
})

test('tells the board it is alive while nothing changes', async ($, on) => {
  const world = setUp(on)
  world.register(SELF)
  await start($)
  await world.clock.settle()
  await openBoard($)
  const first = world.screenOf()?.at ?? 0

  await world.clock.advance(12_000)

  expect((world.screenOf()?.at ?? 0) - first).toBeGreaterThanOrEqual(10_000)
})

test('opens Claude Code’s own pane outside Windows Terminal', async ($, on) => {
  const world = setUp(on, { isTerminal: false })
  world.register({ ...SELF, name: 'Claude Code mods and plugins', nameSource: 'auto' })
  await start($)
  await world.clock.settle()

  expect((await openBoard($)).text).toBe('职责面板已打开。')
  expect(world.opened).toEqual(['role-board'])
  expect(world.splits).toEqual([])

  const ui = await $.ui.mount({
    plugin: 'role-board',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'role-board',
    props: PANE_PROPS,
  })
  const text = drawnText(await ui.drawn())

  expect(text).toContain(`${CIRCLE} Claude Code mods and plugins · 这里<1m`)
  expect(text).toContain('/rename 起个职责名')
  expect((await openBoard($)).text).toBe('职责面板已关闭，/board 再打开。')
})

test('falls back to Claude Code’s own pane when the split fails', async ($, on) => {
  const world = setUp(on, { splitCode: 1 })
  world.register(SELF)
  await start($)

  expect((await openBoard($)).text).toBe('wt.exe 退出码 1。改用 Claude Code 自己的面板：职责面板已打开。')
  expect(world.opened).toEqual(['role-board'])
})

test('writes what this conversation does for the others to read', async ($, on) => {
  const world = setUp(on, { toolMs: 5_000 })
  world.register(SELF)
  await start($)

  await $.prompt.submit({ text: '## 把战斗伤害公式改成乘法\n然后跑测试', origin: { kind: 'composer' }, wait: false })
  await $.turn.start({ text: '把战斗伤害公式改成乘法', turnId: 'turn' })
  const call = $.tool.call({
    tool: 'Edit',
    tool_use_id: 'edit',
    file_path: `${GAME}\\game\\player.gd`,
    old_string: 'a + b',
    new_string: 'a * b',
  })
  await world.clock.advance(300)

  expect(world.cardOf('self')).toMatchObject({
    task: { text: '把战斗伤害公式改成乘法' },
    doing: { tool: 'Edit', text: '改 player.gd' },
    turnAt: T0,
  })

  await world.clock.advance(5_000)
  await call
  await $.turn.complete({
    answer: '**已改成乘法**，测试通过。\n\n改动如下：',
    durationMs: 6_000,
    isAborted: false,
    turnId: 'turn',
    reason: 'answer',
  })
  await world.clock.advance(300)

  expect(world.cardOf('self')).toMatchObject({
    doing: null,
    turnAt: null,
    done: { text: '已改成乘法，测试通过。', outcome: 'answer' },
  })
})

test('leaves a message from another session out of the task', async ($, on) => {
  const world = setUp(on)
  world.register(SELF)
  await start($)

  await $.prompt.submit({ text: '修好存档读取', origin: { kind: 'composer' }, wait: false })
  await $.prompt.submit({ text: '帮我看看这个报错', origin: { kind: 'peer' }, wait: false })
  await world.clock.advance(300)

  expect(world.cardOf('self')?.task?.text).toBe('修好存档读取')
})

test('tells you when another conversation waits for you, and when it is done', async ($, on) => {
  const world = setUp(on)
  world.register(SELF)
  world.register(LEVEL)
  world.card(LEVEL_CARD)
  await start($)
  await world.clock.settle()
  expect(world.toasts).toEqual([])

  world.register({ ...LEVEL, status: 'waiting', waitingFor: 'dialog open', statusUpdatedAt: T0 + 1_000 })
  await world.clock.advance(2_000)
  expect(world.toasts).toEqual([`${BELL} 关卡策划 等你批准 · 跑 git push`])

  world.register({ ...LEVEL, status: 'busy', statusUpdatedAt: T0 + 3_000 })
  await world.clock.advance(2_000)

  // The registry says the turn ended before the card has its answer: the
  // toast waits for the answer.
  world.register({ ...LEVEL, status: 'idle', statusUpdatedAt: T0 + 5_000 })
  await world.clock.advance(2_000)
  expect(world.toasts).toHaveLength(1)

  world.card({
    ...LEVEL_CARD,
    beatAt: T0 + 6_500,
    doing: null,
    turnAt: null,
    done: { text: '已推送 0.2', at: T0 + 5_100, outcome: 'answer' },
  })
  await world.clock.advance(2_000)
  expect(world.toasts).toEqual([`${BELL} 关卡策划 等你批准 · 跑 git push`, `${CHECK} 关卡策划 完成：已推送 0.2`])
})

test('starts a blank card after /clear, and goes on writing the same board', async ($, on) => {
  const world = setUp(on)
  world.register(SELF)
  await start($)
  await openBoard($)
  await $.prompt.submit({ text: '修好存档读取', origin: { kind: 'composer' }, wait: false })
  await world.clock.advance(300)

  world.renew('fresh')
  await $.session.end({ reason: 'clear', sessionId: 'self', resume: { id: 'self' } })
  await world.clock.advance(600)

  expect(world.cardOf('fresh')).toMatchObject({ sessionId: 'fresh', task: null, done: null })
  expect(world.cardOf('self')?.task?.text).toBe('修好存档读取')
  expect(world.screenOf()?.ended).toBe(false)
  expect(world.screenOf('fresh')).toBeUndefined()
})

test('does nothing in a run with nobody at the prompt', async ($, on) => {
  const world = setUp(on)
  world.register(SELF)
  world.register(LEVEL)
  await $.session.start({ cwd: GAME, surface: null, isInteractive: false })
  await world.clock.advance(4_000)

  expect(world.cardOf('self')).toBeUndefined()
  expect(world.reads).toEqual([])
  expect(world.splits).toEqual([])
})
