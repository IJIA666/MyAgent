# configured-subagent-definitions Specification（增量）

## Purpose

本文件是 `openspec/specs/configured-subagent-definitions` 主干规范的增量补丁：2b 将 `mcpServers` 从"解析忽略"提升为"解析生效"，其余字段清单不变。

## MODIFIED Requirements

### Requirement: frontmatter 字段解析与生效清单

系统 MUST 解析 `.md` 定义 frontmatter 并使以下字段生效：`description`（必填）、`tools`（显式工具名单）、`disallowedTools`（剔除名单）、`model`、`maxTurns`、`permissionMode`（仅允许收窄到 `plan` 或保持父模式，不得提升）、`omitClaudeMd`、`mcpServers`（字符串引用或内联定义，见 `subagent-agent-mcp`）、`initialPrompt`（`--agent` 主会话首轮前缀，见 `agent-session-mode`；子代理执行路径不消费）。字段 `effort`、`color`、`skills`、`background`、`memory`、`hooks`、`isolation` 属于本阶段未启用字段：MUST 被解析但 MUST NOT 生效，MUST 记录一条可诊断 warning，MUST NOT 导致文件被拒绝。自定义定义 MUST 使用 `fresh` 上下文策略，`.md` 不得声明上下文策略字段。`.md` 正文 MUST 作为子代理系统提示。

#### Scenario: 合法字段全部生效

- **WHEN** 定义 frontmatter 声明 `tools: [readFile, globSearch, grepSearch]`、`model: deepseek-v4-flash`、`maxTurns: 10` 与 `permissionMode: plan`
- **THEN** 子代理工具面只包含声明的工具
- **AND** 子代理模型解析链在无更高优先级输入时采用 `deepseek-v4-flash`
- **AND** 子代理循环上限为 10 且子权限模式收窄为 `plan`

#### Scenario: tools 与 disallowedTools 组合语义

- **WHEN** 定义只声明 `disallowedTools: [writeFile, editFile]`
- **THEN** 子代理使用默认工具池剔除名单后的集合
- **AND** 名单中的工具既不枚举也不可调用
- **AND** 同时声明 `tools` 与 `disallowedTools` 时，先按 `tools` 允许名单过滤，再剔除 `disallowedTools` 交集成员（允许名单优先，剔除名单只收窄不放开）

#### Scenario: mcpServers 声明生效

- **WHEN** 定义 frontmatter 声明 `mcpServers: [slack]` 或内联定义对象
- **THEN** 字段按 `subagent-agent-mcp` 契约生效（引用共享/内联动态建连）
- **AND** 不再记录"未启用字段"warning

#### Scenario: 未启用字段静默失效但可诊断

- **WHEN** 定义 frontmatter 声明 `memory: project` 或 `hooks: {...}`
- **THEN** 该字段不产生任何运行时行为
- **AND** 系统记录一条 warning 指明该字段将在后续阶段启用

#### Scenario: 省略 tools 时使用默认池

- **WHEN** 定义未声明 `tools` 与 `disallowedTools`
- **THEN** 子代理工具面等于当前策略默认池（对齐 `general-purpose` 的 `['*']` 语义并遵守嵌套与交互安全基线）
