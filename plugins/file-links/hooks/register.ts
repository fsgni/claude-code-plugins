import type { EngineInterface, Register } from 'claude-code'

// How long a path's lookup, and a reply's linked text, stand before they are
// made again: a file Claude creates later becomes a link once it is there.
const LOOKUP_MS = 30_000

// Lookups and replies kept at most; the oldest go first.
const KEPT = 2_000

// Files VS Code shows poorly: a click shows them in Explorer instead.
const SHOWN_IN_FOLDER =
  /\.(png|jpe?g|gif|bmp|ico|webp|tiff?|psd|kra|blend|fbx|glb|pdf|docx?|xlsx?|pptx?|zip|7z|rar|tar|gz|exe|dll|msi|pck|mp3|wav|ogg|flac|mp4|mov|avi|mkv|webm|ttf|otf|woff2?)$/i

// One line of a reply, scanned left to right: code spans (a link when all of
// one is a path), what is a link already (left alone), and paths in running
// text (from a drive, the home folder or a root folder, or relative with a
// folder and an extension). Space, quotes, brackets and the punctuation of
// Chinese prose end a path.
const TOKEN = new RegExp(
  [
    /(?<ticks>`+)(?<inner>.+?)\k<ticks>/u.source,
    /!?\[[^\]]*\]\([^)]*\)/u.source,
    /<[a-zA-Z][\w+.-]*:[^>\s]*>/u.source,
    /\b[a-zA-Z][\w+.-]*:\/\/[^\s<>`]+/u.source,
    /(?<path>(?:(?<![\w\\/.])[A-Za-z]:[\\/]|(?<![\w\\/.~])~[\\/]|(?<![\w\\/.:])\/[\w.@+-]+\/)[^\s`'"<>|*?()[\]{}，。、；：！？（）【】「」『』《》]*|(?<![\w\\/.:@-])(?:\.{1,2}[\\/])?(?:[\p{L}\p{N}_.@+-]+[\\/])+[\p{L}\p{N}_.@+-]+\.[A-Za-z0-9]{1,12}(?::\d+(?::\d+)?)?)/u
      .source,
  ].join('|'),
  'gu',
)

// Punctuation that closes a sentence rather than a path.
const TRAILING = /[.,;:!?'"、，。；：！？]+$/u

// A path, then the line and column it cites: `player.gd:42:5`.
const CITED = /^(?<file>.*?)(?::(?<line>\d+)(?::(?<col>\d+))?)?$/u

// A fence opening or closing a code block.
const FENCE = /^ {0,3}(?<marks>`{3,}|~{3,})/u

type Kind = 'file' | 'dir'

// Where relative paths start, and what `~` is.
type Where = { isWindows: boolean; home: string; cwd: string; at: number }

// What one load of the module keeps: where it is, and what it looked up.
type Linker = {
  where: Where | undefined
  kinds: Map<string, { kind: Kind | undefined; at: number }>
  replies: Map<string, { text: string; at: number }>
}

// Keeps a map to its last `KEPT` entries.
function keep<V>(map: Map<string, V>, key: string, value: V) {
  map.delete(key)
  map.set(key, value)

  for (const oldest of map.keys()) {
    if (map.size <= KEPT) {
      break
    }

    map.delete(oldest)
  }
}

// Forward slashes, no `.` or `..`, no doubled or trailing separator.
function normalized(path: string): string {
  const [head = '', ...rest] = path.replace(/\\/g, '/').split('/')
  const parts: string[] = []

  for (const part of rest) {
    if (part === '..') {
      parts.pop()
    } else if (part !== '' && part !== '.') {
      parts.push(part)
    }
  }

  return `${head}/${parts.join('/')}`
}

function absoluteOf(file: string, where: Where): string {
  const path = file.replace(/\\/g, '/')

  if (path.startsWith('~/')) {
    return normalized(`${where.home}/${path.slice(2)}`)
  }

  // Git Bash spells C:\x as /c/x.
  const drive = where.isWindows ? /^\/(?<letter>[a-zA-Z])\//u.exec(path)?.groups?.letter : undefined

  if (drive !== undefined) {
    return normalized(`${drive.toUpperCase()}:${path.slice(2)}`)
  }

  return normalized(/^([A-Za-z]:\/|\/)/u.test(path) ? path : `${where.cwd}/${path}`)
}

// A code span that holds nothing but a path: one with a folder in it, or a
// file name with an extension; spaces only in a path from a drive or home.
function isPathLike(inner: string): boolean {
  const file = CITED.exec(inner)?.groups?.file ?? inner

  if (/[<>|*?"]|:\/\//u.test(file)) {
    return false
  }

  if (/\s/u.test(file) && !/^([A-Za-z]:[\\/]|~[\\/])/u.test(file)) {
    return false
  }

  return /[\\/]/u.test(file) || /^[\p{L}\p{N}_.@+-]+\.[A-Za-z0-9]{1,12}$/u.test(file)
}

// Where a click goes: VS Code for a file, at the line cited; Explorer, with
// the folder or the file selected, for the rest.
function urlOf(path: string, kind: Kind, line?: string, col?: string): string {
  const encoded = encodeURI(path).replace(/[()#?]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  const rooted = encoded.startsWith('/') ? encoded : `/${encoded}`

  if (kind === 'dir' || SHOWN_IN_FOLDER.test(path)) {
    return `file://${rooted}`
  }

  const at = line === undefined ? '' : `:${line}${col === undefined ? '' : `:${col}`}`

  return `vscode://file${rooted}${at}`
}

async function whereOf($: EngineInterface, linker: Linker, now: number): Promise<Where> {
  if (linker.where !== undefined && now - linker.where.at < LOOKUP_MS) {
    return linker.where
  }

  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
  const where: Where = { isWindows, home: normalized(home), cwd: normalized(await $.session.cwd()), at: now }
  linker.where = where

  return where
}

async function kindOf($: EngineInterface, linker: Linker, path: string, now: number): Promise<Kind | undefined> {
  const held = linker.kinds.get(path)

  if (held !== undefined && now - held.at < LOOKUP_MS) {
    return held.kind
  }

  const stat = await $.fs.stat(path).catch(() => undefined)
  const kind = stat?.kind === 'file' || stat?.kind === 'dir' ? stat.kind : undefined
  keep(linker.kinds, path, { kind, at: now })

  return kind
}

// Where a path that is there links to; undefined for one that is not.
async function linkOf(
  $: EngineInterface,
  linker: Linker,
  where: Where,
  cited: string,
  now: number,
): Promise<string | undefined> {
  const { file = cited, line, col } = CITED.exec(cited)?.groups ?? {}
  const path = absoluteOf(file, where)
  const kind = await kindOf($, linker, path, now)

  return kind === undefined ? undefined : urlOf(path, kind, line, col)
}

async function linkLine($: EngineInterface, linker: Linker, where: Where, line: string, now: number) {
  let linked = ''
  let done = 0

  for (const match of line.matchAll(TOKEN)) {
    const { inner, path } = match.groups ?? {}
    const start = match.index ?? 0
    // A code span is linked whole; a path in running text without the
    // punctuation after it.
    const label = inner !== undefined ? match[0] : path?.replace(TRAILING, '')
    const cited = inner !== undefined ? (isPathLike(inner) ? inner : undefined) : label

    if (label === undefined || cited === undefined || cited === '') {
      continue
    }

    const url = await linkOf($, linker, where, cited, now)

    if (url !== undefined) {
      linked += `${line.slice(done, start)}[${label}](${url})`
      done = start + label.length
    }
  }

  return linked + line.slice(done)
}

// The reply with its paths linked, code blocks left as they are.
async function linkify($: EngineInterface, linker: Linker, text: string): Promise<string> {
  const now = await $.clock.now()
  const held = linker.replies.get(text)

  if (held !== undefined && now - held.at < LOOKUP_MS) {
    return held.text
  }

  const where = await whereOf($, linker, now)
  const lines: string[] = []
  let fence: string | undefined

  for (const line of text.split('\n')) {
    const marks = FENCE.exec(line)?.groups?.marks

    if (marks !== undefined && fence === undefined) {
      fence = marks
    } else if (marks !== undefined && fence !== undefined && marks[0] === fence[0] && marks.length >= fence.length) {
      fence = undefined
    }

    lines.push(fence !== undefined || marks !== undefined ? line : await linkLine($, linker, where, line, now))
  }

  const linked = lines.join('\n')
  keep(linker.replies, text, { text: linked, at: now })

  return linked
}

export const register: Register = on => {
  const linker: Linker = { where: undefined, kinds: new Map(), replies: new Map() }

  // The terminal draws the links Claude Code's own way; a click on one opens
  // it (VS Code takes `vscode:` links, Explorer `file:` ones).
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal') {
      return next(e)
    }

    try {
      const text = await linkify($, linker, e.props.text)

      return text === e.props.text ? next(e) : next({ ...e, props: { ...e.props, text } })
    } catch (error) {
      $.ui.log(`linking failed: ${String(error)}`, { to: 'debug' })

      return next(e)
    }
  })
}
