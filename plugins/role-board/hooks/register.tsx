import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallInput } from 'claude-code'

import type {
  BoardCard,
  BoardLine,
  BoardOutcome,
  BoardRow,
  BoardScreen,
  BoardSpan,
  BoardState,
  BoardTone,
  BoardView,
} from '../types'

// This session's own card, what the board shows, and the screen this session
// writes for its terminal panes.
const card = atom({ plugin: 'role-board', key: 'card' } as const, null)
const board = atom({ plugin: 'role-board', key: 'board' } as const, null)
const boardId = atom({ plugin: 'role-board', key: 'boardId' } as const, null)

// Outside Windows Terminal the board is a pane of Claude Code's own.
const PANE = 'role-board'
const TITLE = '职责'
const PANE_COLUMNS = 34

// The share of the conversation's pane the board's split takes, on the right.
const SPLIT_SIZE = '0.3'

// How often to read the other sessions, to rewrite this one's card and the
// screen while nothing happens, and to ask which sessions still run.
const REFRESH_MS = 2_000
const BEAT_MS = 15_000
const SCREEN_BEAT_MS = 10_000
const ALIVE_MS = 30_000

// A card unwritten this long belongs to a session that no longer runs the plugin.
const STALE_MS = 60_000

// Card changes this close together are written once.
const WRITE_MS = 250

// How long after /clear to start the new conversation's card.
const SETTLE_MS = 300

// How long a conversation's card may lag behind its turn's end before the
// board takes the turn as ended without saying how.
const CATCH_UP_MS = 10_000

// How much of a prompt, an answer or a tool's target a card keeps.
const LINE_CHARS = 80
const TARGET_CHARS = 40

// Nerd Font icons (CaskaydiaMono Nerd Font draws them) and the tones they take.
type Look = { icon: string; tone: BoardTone }

const LOOKS: Record<BoardState | 'done', Look> = {
  working: { icon: '\u{F110}', tone: 'claude' }, // nf-fa-spinner
  waiting: { icon: '\u{F0F3}', tone: 'warning' }, // nf-fa-bell
  done: { icon: '\u{F00C}', tone: 'success' }, // nf-fa-check
  idle: { icon: '\u{F10C}', tone: 'muted' }, // nf-fa-circle_o
}
const FOLDER_LOOK: Look = { icon: '\u{F07C}', tone: 'accent' } // nf-fa-folder_open

// A tone as Claude Code's own pane draws it, in theme colors.
const TONE_STYLES: Record<BoardTone, { color?: string; dimColor?: true; bold?: true }> = {
  claude: { color: 'claude' },
  warning: { color: 'warning' },
  success: { color: 'success' },
  muted: { dimColor: true },
  accent: { color: 'rainbow_blue' },
  strong: { bold: true },
}

const HINT = 'q 关闭'
const STALE_NOTE = '打开它的对话没有回应了 · q 关闭'

// What the engine says a session waits for, in the board's words.
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

// How a tool call reads on the board: a verb, then what it works on.
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
  // What was last written to `board`, and to the screen, as JSON; when the
  // screen was last written.
  shown: string | undefined
  screenShown: string | undefined
  screenAt: number
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

function windowsPath(path: string): string {
  return path.replace(/\//g, '\\')
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
    const { pid, sessionId, cwd, name, nameSource } = raw

    if (typeof pid !== 'number' || typeof sessionId !== 'string' || typeof cwd !== 'string') {
      return undefined
    }

    const hasName = typeof name === 'string' && name !== ''

    return {
      pid,
      sessionId,
      cwd,
      name: hasName ? name : baseName(cwd),
      // Named by the person (or a peer at their word), not made up by
      // Claude Code from the folder or the conversation.
      isNamed: hasName && (nameSource === undefined || nameSource === 'user' || nameSource === 'peer'),
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

function screenPath(dir: string, id: string): string {
  return `${dir}/role-board/screens/${id}.json`
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

// A row's second line: a wait in the warning tone, work plain, the rest muted.
function statusSpan(row: BoardRow): BoardSpan {
  const text = `  ${row.status}`

  return row.state === 'waiting' ? { text, tone: 'warning' } : row.state === 'idle' ? { text, tone: 'muted' } : { text }
}

// The board, line by line: the folder, each of its conversations, then the
// conversations of the other folders.
function linesOf(view: NonNullable<BoardView>): BoardLine[] {
  const lines: BoardLine[] = [
    {
      left: [
        { text: `${FOLDER_LOOK.icon} `, tone: FOLDER_LOOK.tone },
        { text: view.folder, tone: 'strong' },
        { text: `  ${view.rows.length} 个对话`, tone: 'muted' },
      ],
    },
  ]

  for (const row of view.rows) {
    const look = lookOf(row)
    lines.push({ left: [] })
    lines.push({
      left: [
        { text: `${look.icon} `, tone: look.tone },
        { text: row.name, tone: row.isNamed ? 'strong' : 'muted' },
        ...(row.isSelf ? [{ text: ' · 这里', tone: 'muted' as const }] : []),
      ],
      right: [{ text: row.since, tone: 'muted' }],
    })
    lines.push({ left: [statusSpan(row)] })

    if (row.task !== null) {
      lines.push({ left: [{ text: `  ▸ ${row.task}`, tone: 'muted' }] })
    }

    if (row.isSelf && !row.isNamed) {
      lines.push({ left: [{ text: '  /rename 起个职责名', tone: 'muted' }] })
    }
  }

  if (view.others.length > 0) {
    lines.push({ left: [] })
    lines.push({ left: [{ text: '其他文件夹', tone: 'muted' }] })

    for (const other of view.others) {
      lines.push({ left: [{ text: `${LOOKS[other.state].icon} ${other.name} · ${other.folder}`, tone: 'muted' }] })
    }
  }

  return lines
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

// Writes the screen this session's terminal panes draw, once /board opened
// one: when the board changes, and every so often so they see it is alive.
async function writeScreen(
  $: EngineInterface,
  watch: Watch,
  view: BoardView,
  { isEnded = false, isForced = false }: { isEnded?: boolean; isForced?: boolean } = {},
) {
  const id = await read($, boardId)

  if (id === null || watch.dir === undefined) {
    return
  }

  try {
    const lines = view === null ? [{ left: [{ text: '读取中…', tone: 'muted' as const }] }] : linesOf(view)
    const shown = JSON.stringify({ lines, isEnded })
    const at = await $.clock.now()

    if (isForced || shown !== watch.screenShown || at - watch.screenAt >= SCREEN_BEAT_MS) {
      const screen: BoardScreen = { at, ended: isEnded, lines, hint: HINT, staleNote: STALE_NOTE }
      await $.fs.write(screenPath(watch.dir, id), JSON.stringify(screen))
      watch.screenShown = shown
      watch.screenAt = at
    }
  } catch (error) {
    $.ui.log(`screen write failed: ${String(error)}`, { to: 'debug' })
  }
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
    const view: BoardView = {
      folder: baseName(cwd),
      rows: built.map(({ row }) => row),
      others: theirs.map(entry => ({
        sessionId: entry.sessionId,
        name: entry.name,
        folder: baseName(entry.cwd),
        state: stateOf(entry),
      })),
    }

    toastChanges($, watch, built)
    await show($, watch, view)
    await writeScreen($, watch, view)
  } catch (error) {
    $.ui.log(`refresh failed: ${String(error)}`, { to: 'debug' })
  } finally {
    watch.isRefreshing = false
  }
}

// Splits the conversation's Windows Terminal pane: the board on the right,
// drawn by the script the plugin ships, and the focus back on the left.
// Says why when it could not.
async function openSplit($: EngineInterface, watch: Watch): Promise<string | undefined> {
  const { dir } = watch

  if (dir === undefined) {
    return '找不到 Claude Code 的配置目录'
  }

  const script = windowsPath(`${$.plugin.root}/board/board.ps1`)

  if (!(await $.fs.exists(script))) {
    return `插件里缺少 ${script}`
  }

  const id = (await read($, boardId)) ?? (await $.session.id())
  await update($, boardId, () => id)
  await writeScreen($, watch, await read($, board), { isForced: true })

  const { exitCode, stderr } = await $.process.run([
    'wt.exe',
    '-w',
    '0',
    'split-pane',
    '-V',
    '--size',
    SPLIT_SIZE,
    'powershell.exe',
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-Screen',
    windowsPath(screenPath(dir, id)),
    ';',
    'move-focus',
    'left',
  ])

  return exitCode === 0 ? undefined : `wt.exe 退出码 ${exitCode}${stderr.trim() === '' ? '' : `：${stderr.trim()}`}`
}

// Claude Code's own pane, where no terminal split can be had: /board opens
// it, or closes it while it shows.
async function togglePane($: EngineInterface): Promise<string> {
  const pane = (await $.ui.panes()).find(one => one.id === PANE)

  if (pane?.isPlaced === true) {
    await $.ui.close({ id: PANE })

    return '职责面板已关闭，/board 再打开。'
  }

  const opened = await $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })

  return opened.isPlaced ? '职责面板已打开。' : `职责面板还没摆出来：${opened.reason}`
}

async function boot($: EngineInterface, watch: Watch) {
  try {
    await $.command.register({
      name: 'board',
      description: '职责面板：在右侧分屏显示这个文件夹里每个对话在做什么、是否在等你',
    })
    watch.dir = await configDir($)
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
    dir: undefined,
    entries: new Map(),
    alive: undefined,
    aliveAt: 0,
    asked: new Set(),
    ownPid: undefined,
    states: undefined,
    shown: undefined,
    screenShown: undefined,
    screenAt: 0,
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

  // /board splits the terminal in Windows Terminal; anywhere else it opens
  // or closes Claude Code's own pane.
  on('command.run', { command: 'board' }, async $ => {
    if ((await $.env.get('WT_SESSION')) !== undefined) {
      const failure = await openSplit($, watch)

      if (failure === undefined) {
        return { text: '职责面板已在右侧分屏打开，在面板里按 q 关闭。' }
      }

      return { text: `${failure}。改用 Claude Code 自己的面板：${await togglePane($)}` }
    }

    return { text: await togglePane($) }
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

  // /clear goes on under a new session id: its card starts blank. Leaving
  // the conversation closes its terminal panes.
  on('session.end', async ($, e, next) => {
    const ended = await next(e)

    if (e.reason === 'clear') {
      $.clock.after(SETTLE_MS, () => void changeCard($, watch, held => held))
    } else if (e.reason !== 'resume') {
      await writeScreen($, watch, await read($, board), { isEnded: true, isForced: true })
    }

    return ended
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const view = await read($, board)

    if (view === null) {
      return <Text dimColor>读取中…</Text>
    }

    const draw = (spans: readonly BoardSpan[]) =>
      spans.map(span => <Text {...(span.tone === undefined ? {} : TONE_STYLES[span.tone])}>{span.text}</Text>)

    return (
      <Box flexDirection="column">
        {linesOf(view).map((line, index) => (
          <Box key={`line-${index}`} flexDirection="row">
            <Box flexGrow={1} flexShrink={1} overflow="hidden">
              <Text wrap="truncate">{line.left.length > 0 ? draw(line.left) : ' '}</Text>
            </Box>
            {line.right !== undefined && (
              <Box flexShrink={0} marginLeft={1}>
                <Text>{draw(line.right)}</Text>
              </Box>
            )}
          </Box>
        ))}
      </Box>
    )
  })
}
