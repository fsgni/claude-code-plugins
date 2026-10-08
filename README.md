# Claude Code 插件

## context-meter

在输入框上方单独一行，彩色显示上下文用量、订阅的使用额度、当前模型和努力程度，不用再敲 `/context`：

```
  ▰▰▱▱▱▱▱▱ 25% ·  ▱▱▱▱▱▱▱▱ 0% ·  ▰▰▰▰▱▱▱▱ 51%           Opus 5.5  󰈸 max
╭──────────────────────────────────────────────────────────────────────────────╮
│ >                                                                              │
╰──────────────────────────────────────────────────────────────────────────────╯
```

左边是用量：

| 图标 | 含义 |
| --- | --- |
|  | 上下文占用的百分比。数字前带 `~` 的是估算值，出现在刚启动、`/clear` 或 `/compact` 之后、Claude 还没回复的时候 |
|  | 5 小时额度 |
|  | 每周额度 |

只有图标带颜色。进度条是暗色，数字用普通颜色，不和 Claude Code 自己的提示抢注意力。窗口变窄时自动精简：先缩短进度条，再去掉进度条，只留图标和百分比。

右边是模型（）和努力程度。努力程度的图标会随档位变化，颜色也跟着变：

| 档位 | low | medium | high | xhigh | max |
| --- | --- | --- | --- | --- | --- |
| 图标 | 󰡳 | 󰡵 | 󰊚 | 󰡴 | 󰈸 |

更新时机：每轮结束后、一轮中每次调用工具时、`/compact` 和 `/clear` 之后。额度窗口重置后一分钟内归零。模型和努力程度以每次请求实际使用的为准；用 `/effort` 改努力程度会立刻更新，用 `/model` 换模型后，努力程度要等下一次请求才会显示。

额度数据来自 Claude 的回复，所以要等会话里回复过一次才会出现。用 API key 而不是订阅账号的话，只显示上下文。新会话里，努力程度要等发出第一条消息后才会出现。

这一行可以按 `ctrl+x ctrl+a` 折叠或展开。

### 安装

```
/plugin marketplace add fsgni/claude-code-plugins
/plugin install context-meter@fsgni
/reload-plugins
```

图标是 Nerd Font 字符，终端要用 Nerd Fonts 3.5 或更新版本的字体才能全部显示，比如 CaskaydiaMono Nerd Font Mono（在 [Nerd Fonts 的发布页](https://github.com/ryanoasis/nerd-fonts/releases) 下载 CascadiaMono.zip），否则会显示成方框。微软自己的 Cascadia Mono NF 版本较旧，缺少模型用的 Claude 图标。

### 更新

在终端里运行：

```
claude plugin marketplace update fsgni
claude plugin update context-meter@fsgni
```

更新后重启 Claude Code 生效。

## role-board（职责面板）

同一个文件夹里开好几个对话、各管一摊事的时候，输入 `/board`，Windows Terminal 会在右边分出一个窗格，列出这个文件夹里的每个对话，在做什么、是不是在等你：

```
 mygame  3 个对话

 战斗程序 · 这里            <1m
  改 player.gd
  ▸ 把战斗伤害公式改成乘法

 关卡策划                    5m
  等你批准 · 跑 git push
  ▸ 发布 0.2 版本

 剧情文案                   12m
  已把第三章对白定稿
  ▸ 改第三章对白
```

| 图标 | 含义 |
| --- | --- |
|  | 在干活，下一行是正在用的工具和文件 |
|  | 在等你：批准权限、回答问题等，用黄色显示 |
|  | 做完了，下一行是回复的第一句 |
|  | 空闲 |

`▸` 后面是你最后交给它的任务，也就是你发给它的那条消息的第一行。右边是它在当前状态待了多久。

- 名字就是对话的名字。在每个对话里输入 `/rename 战斗程序` 这样起个职责名，没改过名的对话显示成灰色的自动名字。
- 别的对话开始等你、或者做完的时候，会弹一个小通知，不用来回切终端去看。
- 别的文件夹里的对话列在最下面的「其他文件夹」里。
- 面板是真正的终端分屏：占当前窗格的 30%，打开后光标还留在左边的对话里，可以用 `Alt+Shift+方向键` 调宽窄。在面板里按 `q` 关闭；打开它的对话退出时，面板也会跟着关掉。
- 不在 Windows Terminal 里时（比如 VS Code 的终端），`/board` 改用 Claude Code 自己的面板，再输一次关闭。
- 只显示这台电脑上的对话。每个对话把自己的状态写在 `~/.claude/role-board/cards/`（包括你发的消息和回复的第一行），其他对话读这些文件，不消耗 token。
- 要显示"正在做什么"，那个对话也要装了这个插件；没装的只显示工作中、等你、空闲。

### 安装

```
/plugin marketplace add fsgni/claude-code-plugins
/plugin install role-board@fsgni
/reload-plugins
```

已经开着的其他对话，各自运行一次 `/reload-plugins` 才会出现在面板里并显示详情。图标和 context-meter 一样需要 Nerd Font 字体。

### 更新

```
claude plugin marketplace update fsgni
claude plugin update role-board@fsgni
```

更新后重启 Claude Code 生效。
