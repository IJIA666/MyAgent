## ADDED Requirements

### Requirement: Current Claude Permission Modes

系统 MUST 在本 change 中提供 `default`、`acceptEdits`、`plan`、`dontAsk` 和 `bypassPermissions` 五种生产 `PermissionMode`。普通用户界面 MUST 只显示 `Manual`、`Accept edits on` 和 `Plan`；尚未交付的 `auto` MUST NOT 出现在生产类型、配置、帮助、模式切换或运行时分支中。

#### Scenario: Manual asks for an uncovered write

- **WHEN** 当前模式为 `default`，真实文件工具发起未被规则或内建特例覆盖的写入
- **THEN** 系统 MUST 返回 `ask`
- **THEN** 用户界面 MUST 将当前模式显示为 `Manual`

#### Scenario: Accept edits allows an explicitly classified edit

- **WHEN** 当前模式为 `acceptEdits`，工具适配器把调用明确分类为普通 Edit，且资源未命中受保护策略
- **THEN** 系统 MUST 返回 `allow`
- **THEN** 系统 MUST NOT 依据工具名称字符串猜测该调用是否属于 Edit

#### Scenario: Plan denies a side effect

- **WHEN** 当前模式为 `plan`，调用的宿主验证证据表明存在写入、外部副作用或未知副作用
- **THEN** 系统 MUST 返回 `deny`
- **THEN** 普通读取和经过专属分析证明的只读探索 MUST 继续按资源策略评估

#### Scenario: Advanced modes require a trusted entry point

- **WHEN** 项目配置、模型、memory、MCP 或子 Agent 请求启用 `bypassPermissions`
- **THEN** 系统 MUST 拒绝该模式变更
- **WHEN** 受信用户通过显式高级入口启用 `dontAsk` 或 `bypassPermissions`
- **THEN** 系统 MUST 仍执行 managed host cap、受保护资源、调用者验证和实际 sandbox 上限

### Requirement: Single Permission Session State

每个会话 MUST 只拥有一个 `PermissionSessionState`，统一保存 `mode`、`prePlanMode`、已解析规则、session rules、额外目录、单调递增的 `stateVersion` 和有界模式迁移历史。`SessionContext`、权限服务、工具网关、审批适配器和 CLI MUST 引用同一实例。

#### Scenario: A session mode change has one source of truth

- **WHEN** 当前会话通过审批动作切换到 `acceptEdits`
- **THEN** 同一会话后续的网关、CLI 状态和权限决策 MUST 立即观察到相同模式与 `stateVersion`
- **THEN** 新会话 MUST 仍从配置的未来默认模式创建

#### Scenario: A child agent cannot reconstruct a looser state

- **WHEN** 子 Agent 从父会话派生
- **THEN** 子 Agent MUST 继承父级最终有效规则、host cap、工具面和目录快照
- **THEN** 子 Agent MUST NOT 从全局默认值重新计算出更宽松的权限

### Requirement: Typed Tool Authorization Request

每个有副作用的 ToolCatalog 项 MUST 通过受类型约束的工具权限适配器产生规范化请求。请求 MUST 明确携带 runtime tool、稳定权限身份、规范化参数、操作类别、Edit 分类、正式资源证据和可用审批动作。

#### Scenario: A camelCase file tool maps explicitly

- **WHEN** ToolCatalog 注册 `writeFile`、`editFile`、`applyPatch` 或 `createDirectory`
- **THEN** 每个工具 MUST 显式声明其稳定权限身份和真实路径参数
- **THEN** `acceptEdits` MUST 根据该适配器的 Edit 分类工作，而不是匹配 `Write`、`Edit` 等假想运行时名称

#### Scenario: An effectful tool has no adapter

- **WHEN** 一个本地、MCP 或内部有副作用工具没有正式权限适配器
- **THEN** 系统 MUST fail closed
- **THEN** 系统 MUST NOT 使用 `securityCategory`、工具名集合或通用参数回退自动放行

### Requirement: Fixed Permission Evaluation Pipeline

系统 MUST 以固定顺序完成调用者验证、工具适配、host cap、显式规则、Claude 内建基线、模式处理、可信审批、状态提交和执行 grant 签发。最终权限结果 MUST 仍只有 `allow`、`ask`、`deny`。

#### Scenario: A low-level allow cannot override a host deny

- **WHEN** session allow、项目规则、memory 特例或工具候选与 managed host deny 同时命中
- **THEN** 最终结果 MUST 为 `deny`

#### Scenario: An ask is approved

- **WHEN** 最终候选为 `ask` 且用户选择一个工具已经提供的审批动作
- **THEN** 系统 MUST 先原子应用该动作
- **THEN** 只有状态提交成功后才能签发一次性执行 grant

#### Scenario: No prompt surface is available

- **WHEN** 最终候选为 `ask`，但当前调用没有可信审批 UI、审批超时或交互被取消
- **THEN** 系统 MUST 拒绝执行
- **THEN** headless 模式 MUST NOT 隐式转换为 allow

### Requirement: Permission Update Action Union

`PermissionUpdate` MUST 是穷尽判别联合，支持 `addRules`、`replaceRules`、`removeRules`、`setMode`、`addDirectories` 和 `removeDirectories`。一个审批选项 MAY 原子携带多个动作；每个动作 MUST 指定允许的目标来源。

#### Scenario: Accept edits is enabled for the current session

- **WHEN** 用户在普通文件编辑审批中选择“本会话开启 Accept edits on”
- **THEN** 系统 MUST 原子应用 `setMode(acceptEdits, session)`
- **THEN** 系统 MUST NOT 创建一个宽泛文件路径 allow rule
- **THEN** 系统 MUST NOT 改写未来默认模式

#### Scenario: Allow once has no reusable effect

- **WHEN** 用户选择 Allow once
- **THEN** 系统 MUST 只为当前不可变执行计划签发一次性 grant
- **THEN** 系统 MUST NOT 添加规则、目录或改变模式

#### Scenario: A multi-action update fails

- **WHEN** 一个审批选项同时包含 `addDirectories` 和 `setMode`，其中任一动作无法验证或提交
- **THEN** 整个更新 MUST 不生效
- **THEN** 当前副作用 MUST NOT 开始执行

### Requirement: Claude Permission Behavior Baseline

系统 MUST 维护来自 Claude Code 官方文档或本地参考源码的独立行为夹具，并用真实 runtime tool、真实参数和 ToolCatalog 入口验证最终决策、审批动作和状态迁移。

#### Scenario: File edit fixtures use real tool names

- **WHEN** 行为夹具覆盖 Manual、Accept edits on、Plan、默认 memory 根和额外目录
- **THEN** 夹具 MUST 调用 `writeFile`、`editFile`、`applyPatch`、`createDirectory` 等真实名称
- **THEN** expected outcome MUST NOT 由被测 `ToolPermissionService` 自己生成

#### Scenario: A Claude baseline intentionally differs

- **WHEN** MyAgent 因 managed host cap 或平台限制有意比 Claude 更严格
- **THEN** 夹具 MUST 将差异标记为有意加强并记录来源
- **THEN** 系统 MUST NOT 把该差异误称为 Claude 行为

## REMOVED Requirements

### Requirement: Claude Permission Modes

**Reason:** 原要求强制交付未完成的 `auto`，且没有区分普通 UI 与高级受信入口。

**Migration:** 使用 `Current Claude Permission Modes`，当前只交付 Manual、Accept edits on、Plan 和受控高级模式。

### Requirement: Tool Permission Checks

**Reason:** 松散 `checkPermissions(input, context)` 结果不足以约束真实工具身份、输入解析、资源和审批动作。

**Migration:** 使用 `Typed Tool Authorization Request` 和 ToolCatalog 强制适配器。

### Requirement: Unified Permission Decision Flow

**Reason:** 原顺序没有 managed host cap、单一会话状态、原子更新和不可变执行计划。

**Migration:** 使用 `Fixed Permission Evaluation Pipeline`。

### Requirement: Auto Permission Classification

**Reason:** Auto 分类器没有完成设计、评测和保护规则，不属于本 change 的可交付能力。

**Migration:** 从生产路径删除；未来通过独立 change 重新设计。

### Requirement: Permission Updates and Reusable Approval

**Reason:** 原结构只能保存规则，不能表达 Claude 的模式与目录动作。

**Migration:** 使用 `Permission Update Action Union`。

### Requirement: Executor Boundary

**Reason:** 原要求只绑定服务签发的上下文，没有绑定不可变参数、资源、状态和 sandbox profile。

**Migration:** 由 `tool-executor` capability 的不可变执行计划与一次性 grant 契约替代。

### Requirement: Claude Permission Behavior Fixtures

**Reason:** 原夹具允许使用虚拟工具名和被测服务自生成期望值，不能证明真实产品行为。

**Migration:** 使用 `Claude Permission Behavior Baseline`。
