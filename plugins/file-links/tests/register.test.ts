import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

const GAME = 'C:\\Projects\\game'
const HOME = 'C:\\Users\\me'

// A path as the engine hands it to the file system's hooks on Windows.
const pathOf = (path: string) => path.replace(/\//g, '\\')

// The files and folders on the machine beneath the plugin.
const TREE: Record<string, 'file' | 'dir'> = {
  'C:\\Projects\\game': 'dir',
  'C:\\Projects\\game\\README.md': 'file',
  'C:\\Projects\\game\\scripts\\player.gd': 'file',
  'C:\\Projects\\game\\art': 'dir',
  'C:\\Projects\\game\\art\\hero.png': 'file',
  'C:\\Projects\\game\\01-设计文档\\战斗.md': 'file',
  'C:\\Users\\me\\.claude\\settings.json': 'file',
}

// The machine beneath the plugin, and the replies the engine was handed to
// draw, by their text.
function setUp(on: On) {
  const looked: string[] = []
  const drawn: string[] = []

  mock.clock(on, { now: 0 })
  mock.env(on, { USERPROFILE: HOME, OS: 'Windows_NT' })
  on('session.cwd', () => ({ value: GAME }))
  on('fs.stat', (_$, e) => {
    const path = pathOf(e.path)
    looked.push(path)
    const kind = TREE[path]

    if (kind === undefined) {
      throw new Error(`ENOENT: ${path}`)
    }

    return { value: { kind, size: 1, mtimeMs: 0, isLink: false } }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', { component: 'AssistantMessage' }, (_$, e) => {
    drawn.push(e.props.text)

    return { type: 'engine', ref: 0 }
  })

  return { looked, drawn }
}

// A reply's block as a surface draws it.
async function draw($: Engine, text: string, surface: 'terminal' | 'desktop' = 'terminal') {
  await $.ui.mount({
    plugin: 'file-links',
    surface,
    component: 'AssistantMessage',
    props: { text, isFirstOfReply: true },
  })
}

test('links the paths in a reply to VS Code, at the line cited', async ($, on) => {
  const { drawn } = setUp(on)

  await draw(
    $,
    [
      '改了 `scripts/player.gd:42`，说明在 C:\\Projects\\game\\README.md。',
      '设置在 `~/.claude/settings.json`，策划案见 01-设计文档/战斗.md:3。',
    ].join('\n'),
  )

  expect(drawn).toEqual([
    [
      '改了 [`scripts/player.gd:42`](vscode://file/C:/Projects/game/scripts/player.gd:42)，' +
        '说明在 [C:\\Projects\\game\\README.md](vscode://file/C:/Projects/game/README.md)。',
      '设置在 [`~/.claude/settings.json`](vscode://file/C:/Users/me/.claude/settings.json)，' +
        `策划案见 [01-设计文档/战斗.md:3](vscode://file/${encodeURI('C:/Projects/game/01-设计文档/战斗.md')}:3)。`,
    ].join('\n'),
  ])
})

test('shows folders and pictures in Explorer instead', async ($, on) => {
  const { drawn } = setUp(on)

  await draw($, '图在 `art/hero.png`，素材都在 `C:\\Projects\\game\\art\\`。')

  expect(drawn).toEqual([
    '图在 [`art/hero.png`](file:///C:/Projects/game/art/hero.png)，' +
      '素材都在 [`C:\\Projects\\game\\art\\`](file:///C:/Projects/game/art)。',
  ])
})

test('reads a Git Bash path as a Windows one', async ($, on) => {
  const { drawn } = setUp(on)

  await draw($, '在 `/c/Projects/game/README.md` 里')

  expect(drawn).toEqual(['在 [`/c/Projects/game/README.md`](vscode://file/C:/Projects/game/README.md) 里'])
})

test('leaves code, links, web addresses and missing files alone', async ($, on) => {
  const { drawn } = setUp(on)
  const text = [
    '见 [README](https://example.com/README.md) 和 https://example.com/a/b.md',
    '`src/app.ts:42` 不存在，`/reload-plugins` 是命令，and/or 也不是路径，`npm run build` 也不是。',
    '```ps1',
    'Get-Content C:\\Projects\\game\\README.md',
    '```',
  ].join('\n')

  await draw($, text)

  expect(drawn).toEqual([text])
})

test('leaves replies on other surfaces alone', async ($, on) => {
  const { drawn, looked } = setUp(on)

  await draw($, '说明在 `README.md`', 'desktop')

  expect(drawn).toEqual(['说明在 `README.md`'])
  expect(looked).toEqual([])
})

test('looks a path up once while the reply streams in', async ($, on) => {
  const { drawn, looked } = setUp(on)

  await draw($, '说明在 `README.md`')
  await draw($, '说明在 `README.md`，')
  await draw($, '说明在 `README.md`，改好了')

  expect(drawn.at(-1)).toBe('说明在 [`README.md`](vscode://file/C:/Projects/game/README.md)，改好了')
  expect(looked.filter(path => path.endsWith('README.md'))).toHaveLength(1)
})
