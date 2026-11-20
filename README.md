# dsh-adhd-mode

把 [i-have-adhd](https://github.com/ayghri/i-have-adhd) 的输出风格规则装进 DSH：**每个新会话自动生效一次，被 billion-context 折叠后再补一次**，不注册任何开关工具。

`rules.md` 是上游 `skills/i-have-adhd/SKILL.md` 的正文，逐字保留（只去掉 YAML frontmatter），开头加了两行激活说明。

## 行为

1. 新会话的第一个模型步骤前，规则作为一条上下文消息进入对话，排在用户消息之后。
2. 之后不再重复：规则已经在会话历史里。
3. 装了 billion-context 时，压缩发生在**出站请求**上（会话文件不动），规则可能被折叠进摘要。插件读 bili 的日志，数出这个会话折叠了几次：每出现一次新的折叠，就在下一个模型步骤前补投一次。
4. 无工具、无命令、无开关；要停就改配置 `enabled: false`。

## 安装

包目录本身就是一个 bundle（`package.json` + `cordis.patch.yml`），把它装进 profile 即可：

```powershell
git clone https://github.com/juezhong/dsh-adhd-mode
dsh plugin --profile desktop add .\dsh-adhd-mode
```

或在 DSH 里用 `plugin_manager` 的 `install_bundle`，目标填克隆下来的目录路径。装完重启 DSH，新会话即生效；已开着的会话不会追溯。

这个包不发布到 npm（`package.json` 里 `private: true`，`npm publish` 会直接报错），只从 GitHub 安装。

## 配置

在 profile 的 `cordis.patch.yml` 里按行 id 覆盖：

```yaml
- id: adhd-mode
  config:
    enabled: true
```

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后完全不注入 |

环境变量 `DSH_ADHD_BILI_LOG` 可以把 bili 日志路径指向别处（离线联调用的，正常不用设）。

## 清空规则

规则只在该会话里生效。要让某个会话回到默认风格，直接跟助手说 `stop adhd mode` 或 `normal mode` —— 这是规则正文自己的退出条件，插件本身没有开关工具。

## 许可

插件代码 MIT，全文见 `LICENSE`。

`rules.md` 是 [ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd) 的 MIT 正文，归属声明见 `NOTICE`。
