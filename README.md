# Claude Code 插件

## context-meter

在输入框下方提示行的末尾一直显示上下文用量和订阅的使用额度，不用再敲 `/context`：

```
󰍛 ▰▰▱▱▱▱▱▱ 25% 245k/1M · 󰔟 ▱▱▱▱▱▱▱▱ 0% · 󰃭 ▰▰▰▰▱▱▱▱ 51%
```

| 图标 | 含义 |
| --- | --- |
| 󰍛 | 上下文：百分比、已用/总量。数字前带 `~` 的是估算值，出现在刚启动、`/clear` 或 `/compact` 之后、Claude 还没回复的时候 |
| 󰔟 | 5 小时额度 |
| 󰃭 | 每周额度 |

更新时机：每轮结束后、一轮中每次调用工具时、`/compact` 和 `/clear` 之后。额度窗口重置后一分钟内归零。

额度数据来自 Claude 的回复，所以要等会话里回复过一次才会出现。用 API key 而不是订阅账号的话，只显示上下文。

### 安装

```
/plugin marketplace add fsgni/claude-code-plugins
/plugin install context-meter@fsgni
/reload-plugins
```

图标是 Nerd Font 字符，终端要用 Nerd Font 字体才能显示，比如微软的 Cascadia Mono NF（在 [cascadia-code 的发布页](https://github.com/microsoft/cascadia-code/releases) 下载），否则会显示成方框。

### 更新

在终端里运行：

```
claude plugin marketplace update fsgni
claude plugin update context-meter@fsgni
```

更新后重启 Claude Code 生效。
