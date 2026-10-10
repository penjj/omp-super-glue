# agent-porter

把其他 harness 的三类产物注册为 omp 斜杠命令：

|产物|布局|命令形态|
|---|---|---|
|agent|`<harness>/agents/<name>.md`|`/<prefix:name>`（按 prefixRules）|
|command|`<harness>/commands/[ns/]<name>.md`|子目录形式 `/<ns>:<name>`；扁平形式按 prefixRules|
|skill|`<harness>/skills/<name>/SKILL.md`|`/<name>`|

## 安装

```bash
# 一键（omp 插件市场）
omp plugin marketplace add https://github.com/penjj/agent-porter
omp plugin install agent-porter

# 或从本地路径安装
omp install /path/to/agent-porter

# 或手动：克隆到扩展目录
git clone https://github.com/penjj/agent-porter ~/.omp/agent/extensions/agent-porter    # 全局（所有项目）
git clone https://github.com/penjj/agent-porter <project>/.omp/extensions/agent-porter  # 项目级（仅本项目）
```

两种扩展目录 omp 都自动发现（实测）。

## 背景（omp/18.8.6 实测）

- task-agent 发现只认 `.omp/agents`（项目）、`~/.omp/agent/agents`
  （用户）、扩展包 `agents/`、Claude 插件 `agents/` 与内置 agent；
  `.agents/agents`、`.claude/agents`、`.codebuddy/agents`、
  `.qoder/agents` 等均不被发现。
- command/skill 发现只认 `.omp`、`.claude`、`.agent[s]`、`.codex`、
  `.opencode`（skill 另有 `.github`）；`.codebuddy/`、`.qoder/`、
  `.augment/`、`.cursor/` 等其余 harness 的三类产物均不被发现。
- 扩展 API 没有注册 task agent / skill 的方法（无
  `registerTaskAgent`/`registerSkill`）。
- 因此本扩展统一注册命令，触发时按产物类型执行（见下）。

## 扫描（多源组合去重，先到先得）

项目级（cwd）：所有含对应子目录（`agents/`、`commands/`、
`skills/`）的目录——dot-dir 与普通目录皆可（`.codebuddy/`
与 `Doubao/` 同等对待）。`.agents`、`.omp` 优先，其余字典序
（`.claude`、`.qoder`、`.github`、…）。
用户级（~）：`~/.omp/agent/agents`（agent 原生根）、`~/.agents/`
（标准）、其余 `~/` 下任意目录。

command 与 skill 的扫描**跳过原生已覆盖的根**（`.omp`、`.claude`、
`.agent[s]`、`.codex`、`.opencode`，skill 另有 `.github`）——
这些 omp 已原生发现，移植会重复。

同名定义与命令名冲突都是先到先得（按扫描顺序），其余静默
丢弃。会话启动时只打印一行摘要：已加载的技能 / 指令 / 智能体
计数与来源 harness 路径（如 `load .codebuddy、.omp`）。
原件零改动。

## 命令命名

`prefixRules`（`config.json`，默认 `^d2c-(?:block|page)-(\w+)$`
→ `d2c:$1`，另有 `^opsx-(\w+)$` → `opsx:$1`）：
`d2c-block-writer` → `/d2c:writer`、扁平 `opsx-apply.md` →
`/opsx:apply`。command 的子目录形式 `<ns>/<name>.md` 固定映射
`/<ns>:<name>`（claude 约定），不经过 prefixRules。

## 执行方式

**agent**（默认 dispatch）：

- 定义在原生根（`.omp/agents` 或 `~/.omp/agent/agents`）→ 用
  task 工具按名字派发真实子代理，frontmatter 的 `tools`/`model`
  限定由 omp 原生生效。
- 其他来源 → 通用 task 子代理 + 定义全文嵌入任务描述（保留独立
  context 与并行派发；`tools`/`model` 无法按定义限定，命令回执
  里会注明，`model` 别名经 `modelAliases` 映射后同样无法用于
  派发）。
- `--inline`（命令参数）或 `config.mode: "inline"`：定义全文注入
  当前会话；`model` 映射仅对本次注入的回复生效（经
  `before_provider_request` 一次性替换）。

**command**：展开正文（`$ARGUMENTS`、`$@`、`$1..$9` 替换；正文
未用任何占位符时把参数追加到末尾——镜像原生文件指令展开）后
注入当前会话。

**skill**：注入 `SKILL.md` 正文 + `[Skill directory: <skill 目录>]`
+ `User: <参数>`（与原生 `/skill:<name>` 的用户调用模板一致）。

## 已知限制

- **print 模式（`omp -p`）不起 turn**：命令 handler 里
  `sendUserMessage` 排入的消息在 print 模式退出前不会被消费
  （实测所有 deliverAs 变体均不触发）。交互 TUI 与 `--mode rpc`
  正常。
- 运行中新增文件需 `/reload`（命令列表是启动时快照）。
- `tools` 大小写（`Read` vs `read`）由 omp 原生解析器规范化；
  本扩展仅做小写化用于回执显示。

## 配置

与本文件同目录 `config.json`（可选）：

```json
{
  "mode": "dispatch",
  "sources": ["{cwd}/my-agents", "~/my-agents"],
  "prefixRules": [
    ["^d2c-(?:block|page)-(\\w+)$", "d2c:$1"],
    ["^opsx-(\\w+)$", "opsx:$1"]
  ],
  "modelAliases": { "space-bunny": "openrouter/inclusionai/ling-3.1-flash:high" }
}
```

`sources` 是额外的 agent 扫描目录（`{cwd}` 与 `~` 会展开）。
