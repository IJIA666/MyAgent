# configured-subagent-definitions Specification

## Purpose

定义从 Markdown 文件加载并注册自定义子代理类型的契约：`.myagent/agents/*.md`（项目层）与用户层 agents 目录的扫描、built-in > user > project 分层优先级、frontmatter 字段解析（含已声明但本阶段未启用字段的静默忽略）、定义注册与模型可见性。对齐官方 `loadAgentsDir.ts` 的分层加载语义，按 MyAgent 形态适配（无插件体系）。

## ADDED Requirements

### Requirement: 从 agents 目录加载 Markdown 子代理定义

系统 MUST 在子代理定义注册表初始化时扫描项目层 `.myagent/agents/*.md` 与用户层 `~/.myagent/agents/*.md`。子代理类型名 MUST 取自 frontmatter 的 `name` 字段（非空字符串，对齐官方 `parseAgentFromFile` 语义），文件名 MUST NOT 作为类型名（仅作诊断信息）。缺少 `name` 或 `description` 的文件 MUST 被拒绝且不注册，frontmatter 解析失败的文件 MUST 被拒绝且不注册。加载结果 MUST 被缓存（memoize），会话内重复解析返回同一快照。

#### Scenario: 项目层定义被加载

- **WHEN** 项目 `.myagent/agents/` 目录存在 `docs-agent.md` 且 frontmatter 声明 `name: docs-agent` 与合法 `description`
- **THEN** 系统注册类型名为 `docs-agent` 的子代理定义
- **AND** 该类型出现在模型可选的 `subagent_type` 清单中

#### Scenario: 用户层定义被加载

- **WHEN** 用户层 agents 目录存在名为 `reviewer.md` 的文件且 frontmatter 合法
- **THEN** 系统注册类型名为 `reviewer` 的子代理定义
- **AND** 该类型在任意项目中可用

#### Scenario: 同名类型按优先级覆盖

- **WHEN** `built-in`、用户层、项目层存在同类型名 `Explore`
- **THEN** 生效顺序为 built-in > 用户层 > 项目层
- **AND** 项目层同名定义不覆盖用户层，用户层不覆盖 built-in

#### Scenario: frontmatter 非法时拒绝并记录

- **WHEN** agents 目录中的 `.md` 文件缺少必填 `description` 或 frontmatter 无法解析
- **THEN** 系统拒绝注册该类型并记录可诊断日志
- **AND** 不影响其他合法文件的加载

### Requirement: frontmatter 字段解析与生效清单

系统 MUST 解析 `.md` 定义 frontmatter 并使以下字段生效：`description`（必填）、`tools`（显式工具名单）、`disallowedTools`（剔除名单）、`model`、`maxTurns`、`permissionMode`（仅允许收窄到 `plan` 或保持父模式，不得提升）、`omitClaudeMd`。字段 `effort`、`color`、`skills`、`background`、`memory`、`mcpServers`、`hooks`、`isolation` 属于本阶段未启用字段：MUST 被解析但 MUST NOT 生效，MUST 记录一条可诊断 warning，MUST NOT 导致文件被拒绝。自定义定义 MUST 使用 `fresh` 上下文策略，`.md` 不得声明上下文策略字段。`.md` 正文 MUST 作为子代理系统提示。

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

#### Scenario: 未启用字段静默失效但可诊断

- **WHEN** 定义 frontmatter 声明 `memory: project` 或 `hooks: {...}`
- **THEN** 该字段不产生任何运行时行为
- **AND** 系统记录一条 warning 指明该字段将在后续阶段启用

#### Scenario: 省略 tools 时使用默认池

- **WHEN** 定义未声明 `tools` 与 `disallowedTools`
- **THEN** 子代理工具面等于当前策略默认池（对齐 `general-purpose` 的 `['*']` 语义并遵守嵌套与交互安全基线）

### Requirement: 定义注册与模型可见性

系统 MUST 将加载得到的自定义定义注册进统一 `SubagentDefinitionRegistry`，与内置定义同构。模型调用 `Agent` 时 MUST 能按类型名解析自定义定义；未知类型 MUST 返回包含可用类型列表的稳定错误。重复类型名注册 MUST 被拒绝。

#### Scenario: 自定义类型可被模型调用

- **WHEN** 主 Agent 以 `subagent_type: "docs-agent"` 调用 `Agent`
- **THEN** 系统按 `docs-agent` 定义的上下文、工具面与模型解析执行
- **AND** 执行结果与内置类型走同一任务、通知与输出扫描链路

#### Scenario: 未知类型返回可用列表

- **WHEN** 主 Agent 指定未注册的 `subagent_type`
- **THEN** 系统返回包含可诊断错误码和全部已注册类型列表的 `error` 结果
- **AND** 不创建任务索引、transcript 或子代理循环

#### Scenario: 重复注册被拒绝

- **WHEN** 内部注册流程试图注册已存在的类型名
- **THEN** 注册抛错且原有定义保持有效
- **AND** 不会以部分解析的定义覆盖已有定义
