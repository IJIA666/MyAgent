## 背景

MyAgent 当前的权限判断分散在 `WorkMode`、NativeTool、MCP 适配器、`HumanApprovalPlugin`、`ApprovalPolicy`、capability 生命周期和 `ToolExecutor` 中。工具调用可能经过多次模式特判和审批兜底，导致同一调用在不同入口产生不同结果。

本设计以 Claude Code 的权限行为作为唯一基线进行同构实现。这里的“同构”指权限原语、规则匹配、决策顺序、模式转换和授权复用行为一致，不要求复制 Claude Code 的目录、私有基础设施、Anthropic SDK 或内部类名。

## 目标与非目标

**目标:**

- 用统一 `PermissionMode` 替换 `WorkMode`，保持 `default`、`acceptEdits`、`plan`、`auto`、`dontAsk`、`bypassPermissions` 的 Claude Code 语义。
- 实现 Claude 风格 `PermissionRule`、`PermissionUpdate`、`PermissionDecision` 和 `allow / ask / deny / passthrough` 契约。
- 保持 `deny → ask → allow` 规则优先级、工具级和内容级规则、路径规则、MCP 规则及模式转换行为。
- 保留工具特有 `checkPermissions(input, context)`，由统一权限服务协调工具检查和全局规则。
- 将审批适配器限制为 `ask` 交互及 `PermissionUpdate` 应用，删除 `ApprovalPolicy` 二次决策。
- 通过 session 或持久规则实现 once/session/persistent 授权复用。
- 将 `ToolExecutor` 封装在统一调用入口内；若需要防绕过，仅使用内部不可伪造调用上下文。
- 建立 Claude 参考行为夹具，验证相同规则、输入和模式产生相同最终决策及规则更新结果。
- 在实现完成后删除旧权限链路，不保留兼容别名、旧字段双写或新旧运行时并存。

**非目标:**

- 不复制 Claude Code 的源码目录、函数组织、Analytics、GrowthBook 或 Anthropic SDK。
- 不引入 `OperationDescriptor`、`ExecutionPolicy`、`PolicyConstraint`、`PlanSideEffect` 或新的二维阶段/审批模型。
- 不把 capability 继续作为权限授权领域模型；内部调用上下文只能用于防止执行器被绕过。
- 不在本次变更中吸收 OpenCode、OpenClaw、Hermes 或其他竞品的权限语义。
- 不把提示词、工具裁剪或模型自律当作最终权限边界。
- 不为计划文件、诊断文件或某个特殊场景创建 MyAgent 专有权限例外。

## 架构决策

### 1. 采用 Claude 权限行为契约，而不是复制源码结构

权限领域固定采用以下概念：

- `PermissionMode`：`default`、`acceptEdits`、`plan`、`auto`、`dontAsk`、`bypassPermissions`；
- `PermissionBehavior`：`allow`、`deny`、`ask`；
- `PermissionRule`：`source`、`ruleBehavior`、`toolName`、可选 `ruleContent`；
- `PermissionUpdate`：规则和模式的 add/replace/remove/set 操作；
- `PermissionDecision`：最终 `allow`、`ask` 或 `deny`；
- 工具内部检查结果：允许 `passthrough`，表示工具不做最终决定。

选择行为同构而非源码复制，是因为 Claude Code 的平台依赖不能直接移植到 MyAgent，但权限行为需要成为稳定的外部契约。MyAgent 可以使用 `PermissionModeManager`、`PermissionRuleStore`、`ToolPermissionService`、`PermissionPromptAdapter` 等本地类名，只要不改变契约。

### 2. 统一调用入口和权限决策顺序

所有模型工具调用、tail call、NativeTool 和 MCP 调用都进入 `ToolCallGateway`。其内部顺序固定为：

```text
ToolCall
  ↓
ToolPermissionService
  ├─ 全局 deny / ask 规则
  ├─ tool.checkPermissions(input, context)
  ├─ 工具级 deny、内容级 ask 和安全检查
  ├─ bypassPermissions 判断
  ├─ allow 规则匹配
  ├─ passthrough 转 ask
  └─ dontAsk / auto classifier / headless 处理
  ↓
allow / ask / deny
  ↓
PermissionPromptAdapter（仅 ask）
  ↓
应用 PermissionUpdate
  ↓
ToolExecutor
```

选择这一顺序而不是新增抽象的 `OperationInspector → ExecutionPolicy` 链，是因为 Claude Code 的工具特有检查本身就是权限模型的一部分，能够处理 Bash 复合命令、文件路径、MCP 和 Agent 等工具专属语义。

`ApprovalPolicy` 必须删除。审批 UI 不得重新解释模式、风险或工具安全结果，只消费 `ask` 决策中的消息、建议和 `PermissionUpdate`。

### 3. 规则模型和存储映射

规则继续使用 `Tool` 或 `Tool(specifier)` 语法，支持工具级、内容级、路径级、MCP server、MCP tool 和 Agent 规则。规则来源保留 Claude Code 的生命周期语义：`userSettings`、`projectSettings`、`localSettings`、`flagSettings`、`policySettings`、`cliArg`、`command`、`session`。

MyAgent 不需要为每个来源建立独立文件或存储，但 `PermissionRuleStore` 必须能区分来源的优先级、可修改性和生命周期。规则更新必须通过 `PermissionUpdate` 进入 store：

- once：只影响当前调用的审批流程；
- session：写入 `session` 来源，直到会话结束；
- persistent：写入用户、项目或本地配置来源。

规则匹配固定执行 `deny → ask → allow`，具体程度不能越过行为优先级。工具级 deny 可以从模型工具集合中移除工具，内容级 deny 在调用时阻断；显式 ask 在 bypass 模式下仍然要求询问。

### 4. 模式状态和模式后处理

`PermissionModeManager` 是所有模式切换入口，包括 CLI 快捷键、命令、会话恢复和 API 控制消息。

- 进入 `plan` 保存 `prePlanMode`，退出时恢复；
- `plan` 允许读取和只读 shell 探索，不允许源文件编辑；
- `acceptEdits` 只扩大编辑和常见文件系统操作的自动接受范围；
- `dontAsk` 将未被预授权的 `ask` 转为 `deny`；
- `auto` 只处理原本产生 `ask` 的操作，交给 `AutoPermissionClassifier` 判断；
- 进入 `auto` 时剥离会绕过分类器的危险 allow 规则，离开时恢复；
- `bypassPermissions` 跳过普通询问，但显式 ask 和 circuit breaker 仍然生效；
- `auto` 和 `bypassPermissions` 具备独立可用性开关。

模式状态转换集中实现，工具、审批适配器和执行器不能直接解释 `PermissionMode`。

### 5. 工具、MCP 和执行器边界

每个可调用工具必须提供 Claude 风格的 `checkPermissions(input, context)`。工具可以根据自身输入执行内容级检查并返回 `allow`、`ask`、`deny` 或 `passthrough`，但不得创建新的最终决策枚举。

MCP 工具使用规范化的 `mcp__server` 和 `mcp__server__tool` 名称参与规则匹配。MCP 适配器只负责将外部工具注册和输入转换为统一 Tool 契约，不额外引入 unknown capability 或一次性授权语义。

`ToolExecutor` 不负责人工审批、不读取旧 WorkMode、不重新调用旧安全策略。首选将其封装在 `ToolCallGateway` 内；如果结构上仍需内部调用校验，只能传递不可伪造的“已完成权限检查”上下文，不得将其命名为 capability，也不得参与 once/session/persistent 授权。

### 6. OpenAI 平台适配

以下差异属于适配层，不改变权限行为：

- OpenAI tool call 与统一 ToolCall 的字段映射；
- MyAgent ToolRegistry、NativeTool 和 MCP 到 Tool 契约的适配；
- CLI 交互到 `PermissionPromptAdapter` 的适配；
- OpenAI 模型作为 Auto classifier 的调用适配；
- MyAgent 配置和持久化格式到 Claude 权限来源语义的映射。

### 7. 参考行为夹具

建立可重复的参考行为数据集，输入包括规则集合、PermissionMode、工具输入和上下文；输出包括最终 PermissionDecision、decision reason 和 PermissionUpdate。至少覆盖：

- 工具级 allow、ask、deny；
- 内容限定和路径规则；
- deny/ask/allow 冲突；
- Bash 通配、复合命令和 process wrapper；
- 相对路径、工作目录路径、绝对路径和符号链接；
- MCP server 与 MCP tool；
- `plan`、`auto`、`dontAsk`、`bypassPermissions`；
- `passthrough` 转 ask；
- once/session/persistent 规则更新；
- 直接调用执行器和所有 tail call 不绕过 Gateway。

兼容标准是最终行为和规则更新结果一致，不要求目录、类名或私有依赖一致。

### 8. 全量替换和删除边界

删除 `WorkMode`、`PlanSideEffect`、`SafetyCheckResult.status`、`ApprovalPolicy`、旧 `ToolPolicyPort` 决策语义、旧 HumanApprovalPlugin 模式判断、旧 capability 授权中心和 `ToolExecutor` 人工审批兜底。提示词和工具裁剪仅保留为行为优化，不得作为授权来源。

### 迁移计划

1. 建立 Claude 行为契约、规则 fixtures 和新的 PermissionMode/Rule/Decision 类型。
2. 实现 RuleStore、ModeManager、ToolPermissionService、PermissionPromptAdapter 和 Auto classifier 适配层。
3. 将 NativeTool、MCP、Agent、终端、文件系统和 tail call 接入统一 ToolCallGateway。
4. 迁移配置、SessionContext、CLI、审批交互和规则持久化。
5. 删除 ApprovalPolicy、旧 capability 授权路径、WorkMode 分支、PlanSideEffect、SafetyCheckResult.status 和执行器兜底审批。
6. 执行参考行为夹具、全量权限契约测试和绕过路径静态检查。

迁移期间允许按阶段提交代码，但不允许在运行时保留新旧两套权限链路。由于项目没有历史兼容负担，不设计旧配置兼容读取或双写。若阶段性实现未通过行为夹具，应修复同构实现后再继续，不通过兼容分支掩盖差异。

### 回滚策略

本次不提供旧权限模型的运行时回滚。若发布前验证失败，回滚发布版本或回滚整个 change；禁止通过重新启用 `WorkMode`、`ApprovalPolicy` 或旧 capability 路径形成长期双轨运行。

## 风险与权衡

- **规则语义迁移不完整** -> 以 Claude 参考行为夹具覆盖工具级、内容级、路径级、MCP 和复合命令规则；未通过夹具不得进入下一阶段。
- **Auto classifier 误判或不可用** -> 严格保持 Claude 的“只处理 ask”边界、危险 allow 规则剥离、拒绝限制和 headless fallback；分类器不可用时不能静默放行。
- **执行器被绕过** -> 优先封装 `ToolExecutor`；无法封装时使用不可伪造的内部调用上下文，并通过静态搜索和契约测试确认没有外部构造路径。
- **规则来源存储映射错误** -> 将来源优先级、生命周期、可修改性作为 PermissionRuleStore 的契约测试，而不是依赖文件数量表达语义。
- **旧代码残留形成第二套链路** -> 将 `WorkMode`、`PlanSideEffect`、`SafetyCheckResult`、`ApprovalPolicy`、执行器审批和直接执行路径列入最终静态验收清单。
- **Claude 平台细节污染 MyAgent** -> 仅在 OpenAI、ToolRegistry、CLI、配置和持久化适配层处理平台差异，权限核心只依赖中立接口。

## Open Questions

- Auto classifier 的 OpenAI 模型、提示构造和调用超时是否需要独立配置，需在实现前确定，但不得改变 Claude 的 decision boundary。
- MyAgent 当前 ToolExecutor 能否完全封装在 ToolCallGateway 内，需通过现有调用图审计确认；如果不能，采用内部调用上下文作为次优方案。
- Claude 的路径匹配和 Bash/PowerShell 解析能力哪些可以直接复用现有 MyAgent 组件，哪些必须按参考行为补齐，需在任务拆解阶段逐项确认。
