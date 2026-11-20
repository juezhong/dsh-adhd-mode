# 实现细节

## 为什么是 pre-step，而不是常驻 system prompt

上游 i-have-adhd 的 always-on 钩子做三件事：`SessionStart` 触发、读 SKILL.md、把正文打到 stdout，宿主再把它折进会话。规则因此在**对话里出现一次**，而不是每轮重写 system prompt。

DSH 里对应的位置是 `agent/pre-step` 的 waterfall：监听器先 `await next()` 拿到将要进入这一步的消息批次，再决定是否插入自己的消息。

折进 `decision.messages` 的消息由驱动方提交进会话记录（实测：日志里能查到 `user/message`，`source.kind` 保持 `adhd-mode`）。所以不需要入箱：`agent.inbox.prepend` 会把这同一条消息再排到下一个 step 认领，结果是规则在历史里出现两次。只走返回决策这一条路。

常驻注入要写 `ctx.systemPrompt.section()`，那是每轮都进 system prompt 的做法，token 随轮数线性增长；上游明确不是这么做的，所以这里也不这么做。

## 什么时候再注入

只有一种情况：**billion-context 把这个会话折叠过一次**。

- 判重看**会话历史**（`agent.session.surface.nodes` 里的 `user/message`），不是本步批次：批次只含这一步刚认领的输入，不构成历史。
- 历史里有、且折叠计数没变 → 什么也不做。
- 历史里没有（新会话、或历史被 DSH 原生压缩重建过）→ 注入一次。
- 历史里有、但折叠计数涨了 → 补投一次，并更新基线计数。

为什么不能靠 DSH 的压缩事件：装了 billion-context 时它把原生自动压缩关了（`compaction-basic.auto: false`，preset 注入 `biliBasicCompactionPolicy`），`compaction/end` 永远不会触发。bili 的压缩发生在出站请求上——每个请求由存活块加摘要重建，客户端会话文件不动——所以插件这边看历史永远"规则还在"，模型那边可能已经看不到了。

读法：`%USERPROFILE%\.local\state\billion-context\bili.log`，每行带 `[sess=<session id>]`；一次折叠会写几行 `acp-compress-obs` / `acp-proxy: [Compressed ...]`，同一时间戳前缀算一次。插件只读日志尾部 2 MiB，并按 `(文件大小, 折叠数)` 缓存，日志没长就不重读。

没有按轮数/按消息条数触发的注入，也没有注入次数上限：触发条件只有"折叠计数上升"。

## 判定

注入的消息带 `source.kind = 'adhd-mode'`，同时正文首行是 `ADHD MODE ACTIVE`；任一命中就算自己那一份（内容判定是兜底，防止 source 标签丢在持久化路径上）。

## 与上游的差异

| 上游 | 这里 |
| --- | --- |
| Claude Code 的 `SessionStart` 钩子 | DSH 的 `agent/pre-step` |
| 扫 `~/.claude/.i-have-adhd-always` 开关文件 | 配置项 `enabled` |
| 压缩后重新注入（`adds it again after compaction drops it`） | 数 bili 日志里的折叠，每涨一次补投一次 |
| 子代理不注入 | 同样不区分：凡是走 pre-step 的 agent 都会注入 |

## 文本来源

`rules.md` = `https://raw.githubusercontent.com/ayghri/i-have-adhd/main/skills/i-have-adhd/SKILL.md` 去掉 frontmatter 后的正文（7,201 字节原文件，正文逐字保留），前面加两行激活说明。上游许可 MIT。
