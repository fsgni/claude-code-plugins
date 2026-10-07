import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallInput } from 'claude-code'

import type { BoardCard, BoardOutcome, BoardRow, BoardState, BoardView } from '../types'

// This session's own card, what the pane draws, and what became of the pane.
const card = atom({ plugin: 'role-board', key: 'card' } as const, null)
const board = atom({ plugin: 'role-board', key: 'board' } as const, null)
const isDismissed = atom({ plugin: 'role-board', key: 'isDismissed' } as const, false)
const hasOpened = atom({ plugin: 'role-board', key: 'hasOpened' } as const, false)

const PANE = 'role-board'
const TITLE = '职责'

// The width the dock asks for beside the transcript.
const PANE_COLUMNS = 34

// How often to read the other sessions, to rewrite this one's card while
// nothing happens, and to ask which of them still run.
const REFRESH_MS = 2_000
const BEAT_MS = 15_000
const ALIVE_MS = 30_000

// A card unwritten this long belongs to a session that no longer runs the plugin.
const STALE_MS = 60_000

// Card changes this close together are written once.
const WRITE_MS = 250

// How long after /clear to start the new conversation's card.
const SETTLE_MS = 300

// How long a conversation's card may lag behind its turn's end before the
// pane takes the turn as ended without saying how.
const CATCH_UP_MS = 10_000

// How much of a prompt, an answer or a tool's target a card keeps.
const LINE_CHARS = 80
const TARGET_CHARS = 40

// Nerd Font icons (CaskaydiaMono Nerd Font draws them) and the theme colors
// they take.
type Look = { icon: string; color: string }

const LOOKS: Record<BoardState | 'done', Look> = {
  working: { icon: '\u{F110}', color: 'claude' }, // nf-fa-spinner
  waiting: { icon: '\u{F0F3}', color: 'warning' }, // nf-fa-bell
  done: { icon: '\u{F00C}', color: 'success' }, // nf-fa-check
  idle: { icon: '\u{F10C}', color: 'inactive' }, // nf-fa-circle_o
}
const FOLDER_LOOK: Look = { icon: '\u{F07C}', color: 'rainbow_blue' } // nf-fa-folder_open

// What the engine says a session waits for, in the pane's words.
const WAITS: Record<string, string> = {
  'input needed': '等你回答',
  'dialog open': '等你操作',
  'sandbox request': '等你批准联网',
  'goal proposal': '等你确认目标',
  'worker request': '等你批准',
}

const OUTCOMES: Record<BoardOutcome, string> = {
  answer: '完成',
  aborted: '被打断',
  refusal: '拒绝了',
  error: '出错停下',
}

const IDLE = '空闲'
const THINKING = '思考中'
// A session without the plugin says only that it works.
const WORKING = '工作中'

// How a tool call reads in the pane: a verb, then what it works on.
const VERBS: Record<string, string> = {
  Read: '读',
  Edit: '改',
  MultiEdit: '改',
  Write: '写',
  NotebookEdit: '改',
  Bash: '跑',
  PowerShell: '跑',
  Grep: '搜',
  Glob: '找',
  WebFetch: '看',
  WebSearch: '搜网',
  Agent: '派',
  Task: '派',
  Skill: '用技能',
}
const TODO_TOOLS = /^(TodoWrite|Task(Create|Update|List|Get|Stop))$/

// The processes a session can run as: the native build, or Node or Bun with
// the npm package; on macOS and Linux the native build is named for its version.
const SESSION_IMAGE = /^(claude|node|bun)(\.exe)?$|^\d+\.\d+\.\d+/i

// A conversation as Claude Code registers it while it runs:
// `<config>/sessions/<pid>.json`.
type Entry = {
  pid: number
  sessionId: string
  cwd: string
  name: string
  isNamed: boolean
  status: string
  waitingFor: string | undefined
  statusAt: number
  startedAt: number
}

// What one load of the module keeps between refreshes.
type Watch = {
  isInteractive: boolean
  isRunning: boolean
  isRefreshing: boolean
  isWriteDue: boolean
  isFullscreen: boolean
  // Claude Code's configuration folder, where the sessions register.
  dir: string | undefined
  // The registry's files by name, as last read, and when each was written.
  entries: Map<string, { mtimeMs: number; entry: Entry | undefined }>
  // The processes that still run (undefined when nothing answered), when
  // that was asked, and of which.
  alive: Set<number> | undefined
  aliveAt: number
  asked: Set<number>
  ownPid: number | undefined
  // Each conversation's state as the toasts last saw it.
  states: Map<string, BoardState> | undefined
  // What was last written to `board`, as JSON.
  shown: string | undefined
  // The main loop's tool calls running now, oldest first.
  calls: Map<string, NonNullable<BoardCard['doing']>>
  callSeq: number
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)

  return parts[parts.length - 1] || path
}

// One spelling per folder: no trailing separator, forward slashes, one case.
function folderKey(path: string): string {
  return path.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
}

// The same folder, or one inside the other.
function isSameFolder(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

function clip(text: string, chars: number): string {
  const points = [...text]

  return points.length > chars ? `${points.slice(0, chars - 1).join('')}…` : text
}

// The first line that says something, without its Markdown marks.
function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const plain = line
      .replace(/^[\s#>*+\-|]+/, '')
      .replace(/\*\*|__|`/g, '')
      .replace(/\s+/g, ' ')
      .trim()

    if (plain !== '') {
      return plain
    }
  }

  return ''
}

function ago(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)

  if (minutes < 1) {
    return '<1m'
  }

  if (minutes < 60) {
    return `${minutes}m`
  }

  const hours = Math.floor(minutes / 60)

  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

function entryOf(text: string): Entry | undefined {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    const { pid, sessionId, cwd, name } = raw

    if (typeof pid !== 'number' || typeof sessionId !== 'string' || typeof cwd !== 'string') {
      return undefined
    }

    const hasName = typeof name === 'string' && name !== ''

    return {
      pid,
      sessionId,
      cwd,
      name: hasName ? name : baseName(cwd),
      isNamed: hasName && raw.nameSource !== 'derived',
      status: typeof raw.status === 'string' ? raw.status : 'idle',
      waitingFor: typeof raw.waitingFor === 'string' && raw.waitingFor !== '' ? raw.waitingFor : undefined,
      statusAt: numberOr(raw.statusUpdatedAt, numberOr(raw.updatedAt, numberOr(raw.startedAt, 0))),
      startedAt: numberOr(raw.startedAt, 0),
    }
  } catch {
    return undefined
  }
}

function cardOf(text: string): BoardCard | undefined {
  try {
    const raw = JSON.parse(text) as Partial<BoardCard>

    return typeof raw.sessionId === 'string' && typeof raw.beatAt === 'number' ? (raw as BoardCard) : undefined
  } catch {
    return undefined
  }
}

function blankCard(sessionId: string, cwd: string): BoardCard {
  return { sessionId, cwd, beatAt: 0, task: null, doing: null, turnAt: null, done: null }
}

function cardPath(dir: string, sessionId: string): string {
  return `${dir}/role-board/cards/${sessionId}.json`
}

// "改 player.gd", "跑 Run the tests", "搜 damage"
function doingOf(e: ToolCallInput): string {
  const tool = String(e.tool)
  const input = e as unknown as Record<string, unknown>
  const field = (key: string) => (typeof input[key] === 'string' && input[key] !== '' ? String(input[key]) : undefined)

  if (tool === 'AskUserQuestion') {
    return '问你问题'
  }

  if (TODO_TOOLS.test(tool)) {
    return '更新待办'
  }

  if (tool.startsWith('mcp__')) {
    return tool.split('__').slice(2).join('__') || tool
  }

  const path = field('file_path') ?? field('notebook_path')
  const url = field('url')
  const target =
    path !== undefined
      ? baseName(path)
      : tool === 'Bash' || tool === 'PowerShell'
        ? (field('description') ?? field('command'))
        : tool === 'Agent' || tool === 'Task'
          ? (field('description') ?? field('subagent_type'))
          : url !== undefined
            ? (/^[a-z]+:\/\/([^/?#]+)/i.exec(url)?.[1] ?? url)
            : (field('pattern') ?? field('query') ?? field('skill'))
  const verb = VERBS[tool] ?? tool

  return target === undefined ? verb : `${verb} ${clip(target.replace(/\s+/g, ' ').trim(), TARGET_CHARS)}`
}

function stateOf(entry: Entry): BoardState {
  if (entry.status === 'waiting' || entry.waitingFor !== undefined) {
    return 'waiting'
  }

  return entry.status === 'idle' ? 'idle' : 'working'
}

// What a waiting conversation waits for: a tool call it was making waits for
// the person's approval, unless it was asking them a question.
function waitOf(waitingFor: string | undefined, doing: BoardCard['doing']): string {
  if (doing?.tool === 'AskUserQuestion') {
    return WAITS['input needed'] ?? IDLE
  }

  if (doing !== null && (waitingFor === undefined || waitingFor === 'dialog open')) {
    return `等你批准 · ${doing.text}`
  }

  return waitingFor === undefined ? '等你' : (WAITS[waitingFor] ?? `等你：${waitingFor}`)
}

// One conversation's row, and whether its card has caught up with the
// registry (a turn just ended, its answer not written yet).
function rowOf(
  entry: Entry,
  held: BoardCard | undefined,
  isSelf: boolean,
  now: number,
): { row: BoardRow; isCaughtUp: boolean } {
  const state = stateOf(entry)
  const done = held?.done ?? null
  const isDoneFresh = done !== null && done.at >= entry.statusAt - CATCH_UP_MS
  let status = IDLE
  let sinceAt = entry.statusAt
  let isDone = false

  if (state === 'waiting') {
    status = waitOf(entry.waitingFor, held?.doing ?? null)
  } else if (state === 'working') {
    status = held === undefined ? WORKING : (held.doing?.text ?? THINKING)
    sinceAt = held?.turnAt ?? entry.statusAt
  } else if (done !== null && isDoneFresh) {
    isDone = done.outcome === 'answer'
    status = isDone && done.text !== '' ? done.text : OUTCOMES[done.outcome]
    sinceAt = done.at
  }

  return {
    row: {
      sessionId: entry.sessionId,
      name: entry.name,
      isNamed: entry.isNamed,
      isSelf,
      state,
      isDone,
      status,
      task: held?.task?.text ?? null,
      since: ago(now - sinceAt),
    },
    isCaughtUp: state !== 'idle' || held === undefined || isDoneFresh || now - entry.statusAt > CATCH_UP_MS,
  }
}

function lookOf(row: BoardRow): Look {
  return row.state === 'idle' && row.isDone ? LOOKS.done : LOOKS[row.state]
}

// A row's second line: a wait in the warning color, work plain, the rest dim.
function toneOf(row: BoardRow) {
  return row.state === 'waiting' ? { color: LOOKS.waiting.color } : row.state === 'idle' ? { dimColor: true } : {}
}

// Claude Code's configuration folder: where the sessions register, and where
// the cards are kept beside them.
async function configDir($: EngineInterface): Promise<string | undefined> {
  const own = await $.env.get('CLAUDE_CONFIG_DIR')

  if (own !== undefined && own !== '') {
    return own.replace(/[\\/]+$/, '')
  }

  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))

  return home === undefined || home === '' ? undefined : `${home.replace(/[\\/]+$/, '')}/.claude`
}

// The ids of the processes that could be sessions, or undefined when the
// system did not say.
async function livePids($: EngineInterface): Promise<Set<number> | undefined> {
  try {
    const isWindows = (await $.env.get('OS')) === 'Windows_NT'
    const { exitCode, stdout } = await $.process.run(
      isWindows ? ['tasklist', '/FO', 'CSV', '/NH'] : ['ps', '-A', '-o', 'pid=,comm='],
      { timeoutMs: 10_000 },
    )

    if (exitCode !== 0) {
      return undefined
    }

    const pids = new Set<number>()

    for (const line of stdout.split(/\r?\n/)) {
      const match = isWindows ? /^"([^"]+)","(\d+)"/.exec(line) : /^\s*(\d+)\s+(.+)$/.exec(line)
      const image = isWindows ? match?.[1] : baseName(match?.[2] ?? '')
      const pid = isWindows ? match?.[2] : match?.[1]

      if (image !== undefined && pid !== undefined && SESSION_IMAGE.test(image)) {
        pids.add(Number(pid))
      }
    }

    return pids
  } catch (error) {
    $.ui.log(`process list failed: ${String(error)}`, { to: 'debug' })

    return undefined
  }
}

// The registered conversations, each file read again only once rewritten.
async function readEntries($: EngineInterface, watch: Watch, dir: string): Promise<Entry[]> {
  const folder = `${dir}/sessions`
  const listed = await $.fs.list(folder).catch(() => [])
  const entries: Entry[] = []
  const seen = new Set<string>()

  for (const file of listed) {
    // The folder holds each session's secret key too (`<pid>.key`): those are
    // never read.
    if (file.kind !== 'file' || !file.name.endsWith('.json')) {
      continue
    }

    seen.add(file.name)
    let held = watch.entries.get(file.name)

    if (held === undefined || held.mtimeMs !== file.mtimeMs) {
      const text = await $.fs.read(`${folder}/${file.name}`).catch(() => undefined)
      held = { mtimeMs: file.mtimeMs, entry: typeof text === 'string' ? entryOf(text) : undefined }
      watch.entries.set(file.name, held)
    }

    if (held.entry !== undefined) {
      entries.push(held.entry)
    }
  }

  for (const name of [...watch.entries.keys()]) {
    if (!seen.has(name)) {
      watch.entries.delete(name)
    }
  }

  return entries
}

// Asks which processes run every so often, and at once for a session not
// asked about yet: a registry file outlives a session that crashed.
async function askAlive($: EngineInterface, watch: Watch, entries: readonly Entry[], now: number) {
  const isNew = entries.some(entry => !watch.asked.has(entry.pid))

  if (!isNew && now - watch.aliveAt < ALIVE_MS) {
    return
  }

  watch.aliveAt = now
  watch.asked = new Set(entries.map(entry => entry.pid))
  watch.alive = await livePids($)
}

// The cards of the other conversations, those written lately.
async function readCards($: EngineInterface, dir: string, ids: readonly string[], now: number) {
  const found = new Map<string, BoardCard>()

  for (const id of ids) {
    const text = await $.fs.read(cardPath(dir, id)).catch(() => undefined)
    const held = typeof text === 'string' ? cardOf(text) : undefined

    if (held !== undefined && now - held.beatAt <= STALE_MS) {
      found.set(id, held)
    }
  }

  return found
}

async function writeCard($: EngineInterface, watch: Watch) {
  watch.isWriteDue = false

  try {
    const held = await read($, card)

    if (held === null || watch.dir === undefined) {
      return
    }

    const written: BoardCard = { ...held, beatAt: await $.clock.now() }
    await $.fs.write(cardPath(watch.dir, held.sessionId), JSON.stringify(written))
  } catch (error) {
    $.ui.log(`card write failed: ${String(error)}`, { to: 'debug' })
  }
}

function writeSoon($: EngineInterface, watch: Watch) {
  if (!watch.isWriteDue) {
    watch.isWriteDue = true
    $.clock.after(WRITE_MS, () => void writeCard($, watch))
  }
}

// Changes this session's card and writes it soon. After /clear the session
// goes on under a new id, whose card starts blank.
async function changeCard($: EngineInterface, watch: Watch, change: (held: BoardCard) => BoardCard) {
  if (!watch.isInteractive) {
    return
  }

  try {
    const sessionId = await $.session.id()
    const cwd = await $.session.cwd()
    await update($, card, held => change(held !== null && held.sessionId === sessionId ? held : blankCard(sessionId, cwd)))
    writeSoon($, watch)
  } catch (error) {
    $.ui.log(`card change failed: ${String(error)}`, { to: 'debug' })
  }
}

async function showDoing($: EngineInterface, watch: Watch) {
  const newest = [...watch.calls.values()].pop() ?? null
  await changeCard($, watch, held => ({ ...held, doing: newest }))
}

// Toasts when another conversation of the folder starts waiting for the
// person, or ends its turn. A turn whose card has not caught up is told on a
// later refresh, with its answer.
function toastChanges(
  $: EngineInterface,
  watch: Watch,
  built: readonly { row: BoardRow; isCaughtUp: boolean }[],
) {
  const before = watch.states
  watch.states = new Map(
    built.map(({ row, isCaughtUp }) => [row.sessionId, isCaughtUp ? row.state : (before?.get(row.sessionId) ?? row.state)]),
  )

  if (before === undefined) {
    return
  }

  for (const { row, isCaughtUp } of built) {
    const was = before.get(row.sessionId)

    if (row.isSelf || !isCaughtUp || was === undefined || was === row.state) {
      continue
    }

    if (row.state === 'waiting') {
      $.ui.toast(`${LOOKS.waiting.icon} ${row.name} ${row.status}`, { timeoutMs: 8_000 })
    } else if (row.state === 'idle' && was === 'working' && row.status !== OUTCOMES.aborted) {
      const said = row.isDone ? `完成：${row.status}` : row.status
      $.ui.toast(`${lookOf(row).icon} ${row.name} ${said}`, { timeoutMs: 6_000 })
    }
  }
}

async function show($: EngineInterface, watch: Watch, view: BoardView) {
  const shown = JSON.stringify(view)

  if (shown !== watch.shown) {
    watch.shown = shown
    await update($, board, () => view)
  }
}

// The pane opens by itself, once a session, when another conversation shares
// the folder and the pane would sit beside the transcript; never after the
// person closed it.
async function openUnasked($: EngineInterface, watch: Watch, rows: readonly BoardRow[]) {
  if (!watch.isFullscreen || !rows.some(row => !row.isSelf)) {
    return
  }

  if ((await read($, hasOpened)) || (await read($, isDismissed))) {
    return
  }

  await update($, hasOpened, () => true)
  await $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })
}

async function refresh($: EngineInterface, watch: Watch) {
  const { dir } = watch

  if (!watch.isInteractive || watch.isRefreshing || dir === undefined) {
    return
  }

  watch.isRefreshing = true

  try {
    const now = await $.clock.now()
    const entries = await readEntries($, watch, dir)
    await askAlive($, watch, entries, now)

    const live = entries.filter(entry => watch.alive?.has(entry.pid) ?? true)
    const sessionId = await $.session.id()
    const self = live.find(entry => entry.sessionId === sessionId) ?? live.find(entry => entry.pid === watch.ownPid)
    watch.ownPid = self?.pid ?? watch.ownPid

    const cwd = await $.session.cwd()
    const here = folderKey(cwd)
    const byStart = (a: Entry, b: Entry) => a.startedAt - b.startedAt
    const mine = live.filter(entry => isSameFolder(folderKey(entry.cwd), here)).sort(byStart)
    const theirs = live.filter(entry => !mine.includes(entry)).sort(byStart)
    const peers = mine.filter(entry => entry !== self)
    const cards = await readCards($, dir, peers.map(entry => entry.sessionId), now)
    const own = (await read($, card)) ?? undefined
    const built = mine.map(entry =>
      entry === self ? rowOf(entry, own, true, now) : rowOf(entry, cards.get(entry.sessionId), false, now),
    )
    const rows = built.map(({ row }) => row)

    toastChanges($, watch, built)
    await show($, watch, {
      folder: baseName(cwd),
      rows,
      others: theirs.map(entry => ({
        sessionId: entry.sessionId,
        name: entry.name,
        folder: baseName(entry.cwd),
        state: stateOf(entry),
      })),
    })
    await openUnasked($, watch, rows)
  } catch (error) {
    $.ui.log(`refresh failed: ${String(error)}`, { to: 'debug' })
  } finally {
    watch.isRefreshing = false
  }
}

async function boot($: EngineInterface, watch: Watch) {
  try {
    await $.command.register({
      name: 'board',
      description: '职责面板：这个文件夹里的每个对话在做什么、是否在等你（再输入一次关闭）',
    })
    watch.dir = await configDir($)
    watch.isFullscreen = (await $.settings.read()).tui === 'fullscreen'
    await changeCard($, watch, held => held)
  } catch (error) {
    $.ui.log(`start failed: ${String(error)}`, { to: 'debug' })
  }

  if (!watch.isRunning) {
    watch.isRunning = true
    $.clock.every(REFRESH_MS, () => void refresh($, watch))
    $.clock.every(BEAT_MS, () => void changeCard($, watch, held => held))
  }

  void refresh($, watch)
}

export const register: Register = on => {
  const watch: Watch = {
    isInteractive: false,
    isRunning: false,
    isRefreshing: false,
    isWriteDue: false,
    isFullscreen: false,
    dir: undefined,
    entries: new Map(),
    alive: undefined,
    aliveAt: 0,
    asked: new Set(),
    ownPid: undefined,
    states: undefined,
    shown: undefined,
    calls: new Map(),
    callSeq: 0,
  }

  on('session.start', async ($, e, next) => {
    watch.isInteractive = e.isInteractive

    if (watch.isInteractive) {
      await boot($, watch)
    }

    return next(e)
  })

  // /board opens the pane, or closes it while it shows.
  on('command.run', { command: 'board' }, async $ => {
    const pane = (await $.ui.panes()).find(one => one.id === PANE)

    if (pane?.isPlaced === true) {
      await update($, isDismissed, () => true)
      await $.ui.close({ id: PANE })

      return { text: '职责面板已关闭，/board 再打开。' }
    }

    await update($, isDismissed, () => false)
    await update($, hasOpened, () => true)
    const opened = await $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })

    return { text: opened.isPlaced ? '职责面板已打开。' : `职责面板还没摆出来：${opened.reason}` }
  })

  // Closed by the person, the pane stays closed until /board.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') {
      await update($, isDismissed, () => true)
    }

    return next(e)
  })

  // The person's own prompt is the conversation's task, by its first line.
  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)
    const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    const text = entered.text === undefined ? '' : clip(firstLine(entered.text), LINE_CHARS)

    if (isPerson && text !== '') {
      const at = await $.clock.now()
      await changeCard($, watch, held => ({ ...held, task: { text, at } }))
    }

    return entered
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    const at = await $.clock.now()
    watch.calls.clear()
    await changeCard($, watch, held => ({ ...held, turnAt: at, doing: null }))

    return started
  })

  // What the main loop runs, while it runs; a subagent's calls stay its own.
  on('tool.call', async ($, e, next) => {
    if (!watch.isInteractive || e.agentId !== undefined) {
      return next(e)
    }

    watch.callSeq += 1
    const id = e.tool_use_id ?? `call-${watch.callSeq}`
    watch.calls.set(id, { tool: String(e.tool), text: doingOf(e), at: await $.clock.now() })
    await showDoing($, watch)

    try {
      return await next(e)
    } finally {
      watch.calls.delete(id)
      await showDoing($, watch)
    }
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)

    if (e.agentId === undefined) {
      const at = await $.clock.now()
      const text = clip(firstLine(e.answer), LINE_CHARS)
      watch.calls.clear()
      await changeCard($, watch, held => ({
        ...held,
        turnAt: null,
        doing: null,
        done: { text, at, outcome: e.reason },
      }))
    }

    return completed
  })

  // /clear goes on under a new session id: its card starts blank.
  on('session.end', async ($, e, next) => {
    const ended = await next(e)

    if (e.reason === 'clear') {
      $.clock.after(SETTLE_MS, () => void changeCard($, watch, held => held))
    }

    return ended
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const view = await read($, board)

    if (view === null) {
      return <Text dimColor>读取中…</Text>
    }

    return (
      <Box flexDirection="column">
        <Text wrap="truncate">
          <Text color={FOLDER_LOOK.color}>{`${FOLDER_LOOK.icon} `}</Text>
          <Text bold>{view.folder}</Text>
          <Text dimColor>{`  ${view.rows.length} 个对话`}</Text>
        </Text>
        {view.rows.map(row => (
          <Box key={row.sessionId} flexDirection="column" marginTop={1}>
            <Box flexDirection="row">
              <Box flexGrow={1} flexShrink={1} overflow="hidden">
                <Text wrap="truncate">
                  <Text color={lookOf(row).color}>{`${lookOf(row).icon} `}</Text>
                  {row.isNamed ? <Text bold>{row.name}</Text> : <Text dimColor>{row.name}</Text>}
                  {row.isSelf && <Text dimColor>{' · 这里'}</Text>}
                </Text>
              </Box>
              <Box flexShrink={0} marginLeft={1}>
                <Text dimColor>{row.since}</Text>
              </Box>
            </Box>
            <Text wrap="truncate" {...toneOf(row)}>{`  ${row.status}`}</Text>
            {row.task !== null && <Text wrap="truncate" dimColor>{`  ▸ ${row.task}`}</Text>}
            {row.isSelf && !row.isNamed && <Text wrap="truncate" dimColor>{'  /rename 起个职责名'}</Text>}
          </Box>
        ))}
        {view.others.length > 0 && (
          <Box key="others" flexDirection="column" marginTop={1}>
            <Text dimColor>其他文件夹</Text>
            {view.others.map(other => (
              <Text wrap="truncate" dimColor>{`${LOOKS[other.state].icon} ${other.name} · ${other.folder}`}</Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
