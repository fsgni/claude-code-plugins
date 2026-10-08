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
