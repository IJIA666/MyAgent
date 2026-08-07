# agent-session-mode Specification

## Purpose

定义 `myagent --agent <type>` 主会话启动模式的行为契约：以已注册子代理定义作为主会话的装配来源（system prompt 组合注入、model 覆盖、tools 名单裁剪、initialPrompt 首轮合并），与官方一致的主线程不消费字段（permissionMode/hooks/mcpServers/maxTurns/background），以及 Agent 工具的名单语义（省略或 `['*']` 时保留，显式名单只含名单工具）。**有意差异**：system prompt 为"基础人设 + 定义提示"组合语义（官方为替换语义）——MyAgent 基础人设含安全指令红线，替换会丢失安全基线，故保留组合并在本规范明示不等价。

## Requirements

### Requirement: --agent 参数启动主会话

系统 MUST 解析 CLI 参数 `--agent <type>`，并在启动时从 `SubagentDefinitionRegistry` 解析对应定义。类型未知时 MUST 提示未找到并回退默认会话行为（官方 warn 语义），MUST NOT 阻断启动。省略 `--agent` 时 MUST 保持现有默认会话行为不变。

#### Scenario: 以已注册类型启动

- **WHEN** 用户以 `myagent --agent reviewer` 启动且 `reviewer` 已注册
- **THEN** 主会话按 `reviewer` 定义装配（system prompt/model/tools/initialPrompt）
- **AND** 会话正常进入交互循环

#### Scenario: 未知类型回退默认

- **WHEN** 用户以 `myagent --agent not-exist` 启动且类型未注册
- **THEN** 系统提示该类型不存在并回退默认会话行为
- **AND** 不阻断启动

#### Scenario: 省略参数保持默认

- **WHEN** 用户以 `myagent`（无 `--agent`）启动
- **THEN** 主会话使用默认装配，行为与现状一致

#### Scenario: exact-fork 定义不可作为装配来源

- **WHEN** fork 开关开启且用户以 `--agent exact-fork` 启动
- **THEN** 系统提示该定义不适用于主会话并跳过其 system prompt 装配
- **AND** 会话以默认行为继续（exact-fork 冻结父 system 字节）

### Requirement: 主线程应用定义的 system prompt、model、tools 与 initialPrompt

系统 MUST 在 `--agent` 模式下应用定义以下字段：`systemPrompt`（定义提示经**定义 prompt 构造器统一调用**——覆盖自定义 `.md` 正文与内置 Explore/Plan 提示；结果经会话持久附加位注入系统提示，**组合语义**：基础人设 `BASE_SYSTEM_PROMPT` 保留在前、定义提示附加在后；`RuleManager` 构造与规则重载 MUST NOT 覆盖该附加位；此为与官方"替换"语义的**有意差异**）、`model`（非 `inherit` 时覆盖主会话模型，`inherit` 保持默认）、`tools`/`disallowedTools`（裁剪主线程工具面；省略或 `['*']` 时保留 `Agent` 工具，显式名单只含名单中工具、写入 `Agent` 才保留——对齐官方 `agentToolUtils` 名单语义）、`initialPrompt`（作为首轮前缀与首条真实用户输入合并为同一条 user 消息，MUST NOT 提前插入独立消息）。

#### Scenario: system prompt 为组合语义且不被覆盖

- **WHEN** 以定义启动且定义提示为"你是评审员"
- **THEN** 主会话系统提示为基础人设 + 定义提示（组合）
- **AND** 运行中规则重载或技能变更后定义提示仍保留

#### Scenario: 内置 Explore/Plan 提示生效

- **WHEN** 以 `--agent Explore` 或 `--agent Plan` 启动
- **THEN** 主会话系统提示包含对应的只读搜索/规划指令（经定义 prompt 构造器输出）
- **AND** 基础人设保留（组合语义）

#### Scenario: model 非 inherit 时覆盖主会话

- **WHEN** 定义声明 `model: deepseek-v4-pro` 且以 `--agent` 启动
- **THEN** 主会话模型切换为 `deepseek-v4-pro`
- **AND** 父模型切换行为（switchModel）与日志保持既有语义

#### Scenario: model 为 inherit 时保持默认

- **WHEN** 定义未声明 `model` 或声明 `model: inherit`
- **THEN** 主会话模型保持默认配置

#### Scenario: 省略或通配 tools 时保留 Agent 工具

- **WHEN** 定义未声明 `tools` 或声明 `tools: ['*']`
- **THEN** 主线程工具面为默认池（含 `Agent` 工具）
- **AND** `disallowedTools` 剔除仍生效

#### Scenario: 显式 tools 名单只含名单工具

- **WHEN** 定义声明 `tools: [readFile, globSearch]`
- **THEN** 主线程工具面只包含名单中工具
- **AND** `Agent` 仅在名单中显式写入时才保留

#### Scenario: initialPrompt 与首条输入合并

- **WHEN** 定义声明 `initialPrompt` 且用户提交首条消息
- **THEN** 首条模型请求的 user 消息为 `initialPrompt` 内容与用户输入拼接的同一条消息
- **AND** 不产生独立的前置 user 消息

### Requirement: 主线程不消费定义的部分字段

系统 MUST 在 `--agent` 模式下不消费定义级 `permissionMode`、`hooks`、`mcpServers`、`maxTurns`、`background`（与官方主线程语义一致：这些字段仅子代理执行路径消费）。主线程权限模式 MUST 仍由 CLI/settings 决定。主线程内调用子代理时，子代理执行 MUST 走既有子代理装配路径（其定义字段正常生效，模型解析以主会话当前模型为父模型）。

#### Scenario: 权限模式不由定义决定

- **WHEN** 定义声明 `permissionMode: plan` 且以 `--agent` 启动
- **THEN** 主会话权限模式不改变（仍由 CLI/settings 决定）
- **AND** 定义其余生效字段不受影响

#### Scenario: 主线程内子代理定义字段正常生效

- **WHEN** `--agent` 主会话调用 `Agent` 工具启动子代理
- **THEN** 子代理按其定义装配（含其专属 MCP、maxTurns、权限收窄等）
- **AND** 子代理模型解析以主会话当前模型为父模型
