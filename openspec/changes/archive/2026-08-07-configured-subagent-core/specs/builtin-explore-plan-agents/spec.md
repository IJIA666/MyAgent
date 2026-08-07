# builtin-explore-plan-agents Specification

## Purpose

定义内置 Explore 与 Plan 子代理的行为契约：只读允许名单工具池 + 固定 `permissionMode: plan`（权限网关级强制只读，对齐官方 `exploreAgent.ts` / `planAgent.ts` 的只读语义并收紧）、`omitClaudeMd` 语义（不加载 CLAUDE.md 规则）、规划报告输出格式，以及 `general-purpose` 全工具池完善（对齐官方 `tools: ['*']`，但不突破 MyAgent 嵌套深度与交互安全基线）。

## ADDED Requirements

### Requirement: Explore 是只读快速搜索子代理

系统 MUST 内置 `Explore` 子代理，其工具面 MUST 为只读**允许名单**（对齐 MyAgent 实际注册名：`readFile`、`readManyFiles`、`listFiles`、`globSearch`、`grepSearch`、`gitShowStatus`、`gitShowLog`、`gitShowDiff`、`Bash`、`PowerShell` 及既有只读技能查询工具），不包含任何写工具。`Explore` 定义 MUST 固定 `permissionMode: plan`：即使父会话为 `bypassPermissions` 或 `acceptEdits`，子权限状态 MUST 经权限网关拒绝写操作与未知操作（`tool-permission-service` 的 plan 模式拒绝语义）。`Explore` 定义 MUST 声明 `omitClaudeMd: true`：其上下文 MUST 不加载 CLAUDE.md 规则投影。`Explore` 的系统提示 MUST 描述只读搜索专家角色并禁止任何文件修改与状态变更命令。

#### Scenario: Explore 只能读不能写

- **WHEN** 模型调用 `Explore` 且任务要求修改文件
- **THEN** 子代理工具面不含任何写工具，编辑请求必然失败
- **AND** 权限网关在 plan 模式下拒绝绕过允许名单的写操作
- **AND** 系统提示明确声明只读约束

#### Scenario: Explore 在 bypass 父会话下仍只读

- **WHEN** 父会话权限模式为 `bypassPermissions` 且模型调用 `Explore`
- **THEN** 子权限状态收窄为 `plan`
- **AND** Shell 写命令与文件写工具被权限网关拒绝

#### Scenario: Explore 不加载规则

- **WHEN** 系统创建 `Explore` 子代理上下文
- **THEN** 该上下文不包含 CLAUDE.md 规则内容
- **AND** 长期记忆投影保持所有 fresh 子代理一致的既有行为（不加载）

#### Scenario: Explore 保留只读 Shell 能力

- **WHEN** `Explore` 需要查看目录结构或 git 状态
- **THEN** 允许 `ls`、`git status`、`git log`、`git diff` 等只读 Shell 命令
- **AND** 系统提示明令禁止 mkdir、touch、rm、cp、mv、git add、git commit 等变更命令

### Requirement: Plan 是只读架构规划子代理

系统 MUST 内置 `Plan` 子代理，其工具面 MUST 与 `Explore` 同为只读允许名单，MUST 固定 `permissionMode: plan`，且 MUST 声明 `omitClaudeMd: true`。`Plan` 的系统提示 MUST 描述软件架构师角色：探索代码库、设计实施方案并输出包含关键实现文件的步骤化计划；MUST 同样禁止任何文件修改。

#### Scenario: Plan 探索并输出实施计划

- **WHEN** 模型调用 `Plan` 并要求设计某功能的实施策略
- **THEN** 子代理使用只读工具探索代码库
- **AND** 最终输出包含分步实施策略与 3-5 个关键实现文件的计划

#### Scenario: Plan 不加载规则

- **WHEN** 系统创建 `Plan` 子代理上下文
- **THEN** 该上下文不包含 CLAUDE.md 规则内容
- **AND** 长期记忆投影保持所有 fresh 子代理一致的既有行为（不加载）

### Requirement: general-purpose 使用全工具池

系统 MUST 使 `general-purpose` 子代理的工具面对齐官方 `tools: ['*']`：除既有交互与会话控制排除项（`ask_user_question`、`human_interruption`、会话生命周期工具）与嵌套深度基线外，父注册表中策略允许的工具全部可见。`general-purpose` 不声明 `omitClaudeMd` 与 `permissionMode`，保持加载规则、不加载长期记忆的既有行为。

#### Scenario: general-purpose 可见全量父工具池

- **WHEN** 模型调用 `general-purpose` 并枚举工具
- **THEN** 工具面为父注册表全部策略放行工具（含 Shell、文件、搜索、MCP）
- **AND** 交互与生命周期工具仍不可见

#### Scenario: general-purpose 不突破嵌套深度

- **WHEN** `general-purpose` 子代理尝试调用 `Agent`
- **THEN** 其工具列表中不含 `Agent`
- **AND** 不产生新的子代理

#### Scenario: general-purpose 保持规则装载且不加载长期记忆

- **WHEN** 系统创建 `general-purpose` 子代理上下文
- **THEN** 该上下文加载适用的全局/项目规则（与阶段 1 行为一致）
- **AND** 长期记忆投影保持所有 fresh 子代理一致的既有行为（不加载，`createEmptyMemorySnapshot`）
