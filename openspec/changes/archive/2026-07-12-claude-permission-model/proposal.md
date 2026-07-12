## 改造原因

当前权限体系将 `WorkMode`、工具安全检查、Plan 特判、`ApprovalPolicy`、人工审批插件、capability 生命周期和执行器兜底逻辑分散在多个边界中。同一次工具调用可能被多个组件重复判断，导致模式语义不一致，也无法保证所有 NativeTool、MCP、tail call 和直接执行路径经过同一权限入口。

本项目没有历史兼容负担，因此不再进行局部修补或保留旧模型。本次以 Claude Code 的权限行为作为唯一基线，进行同构实现：保持其权限模式、规则语法、工具检查、决策顺序、模式转换和审批复用行为；仅将 Anthropic 私有基础设施替换为 MyAgent 的 OpenAI 协议、工具注册、CLI 交互和执行边界。

## 变更内容

- **BREAKING**：删除 `WorkMode`、`PlanSideEffect`、旧 `SafetyCheckResult.status`、`ApprovalPolicy` 以及以 capability 为中心的授权语义。
- **BREAKING**：将权限模式统一替换为 Claude Code 行为基线：`default`、`acceptEdits`、`plan`、`auto`、`dontAsk`、`bypassPermissions`。
- 新增 Claude 风格的 `PermissionRule`、`PermissionUpdate`、`PermissionDecision` 和 `allow / ask / deny / passthrough` 决策流程。
- 所有工具保留工具特有的 `checkPermissions(input, context)`，并通过统一的工具权限服务完成最终决策。
- 保持 `deny → ask → allow` 规则优先级，以及工具级、内容级、路径级和 MCP 规则语义。
- 完整迁移 Plan 进入、退出、`prePlanMode` 恢复和 Auto 危险 allow 规则剥离逻辑。
- 将审批 UI 收敛为只处理 `ask` 结果和 `PermissionUpdate`，删除审批插件和策略层的二次决策。
- 将 once/session/persistent 授权转换为 session 或持久规则更新；如执行器需要防绕过，只保留内部不可伪造调用上下文。
- 建立 Claude 参考行为夹具，验证规则、工具输入、模式和规则更新结果的同构性。
- **BREAKING**：所有工具调用必须经过统一入口；删除执行器内部人工审批和旧权限链路，不提供兼容别名或双写。

## 业务能力

### 新增业务能力

- `permission-model`: 提供与 Claude Code 权限行为同构的统一模式、规则、工具检查、审批和执行授权能力。

### 修改业务能力

- `approval-capability-lifecycle`: 移除 capability 作为授权中心，改为 Claude 风格的 once/session/persistent 规则更新。
- `approval-policy-contract`: 删除独立审批策略层，审批界面只消费统一权限决策的 `ask` 结果。
- `security-modes`: 用 Claude Code `PermissionMode` 替换 `WorkMode`，并实现模式转换和安全边界。
- `cli-workmode-command`: 将 CLI 模式选择和切换改为统一 PermissionMode 语义。
- `session-context-contract`: 保存 PermissionMode、`prePlanMode`、规则来源和模式转换状态。
- `tool-policy-port`: 用 Claude 风格工具 `checkPermissions` 和统一权限服务替换旧 ToolPolicyPort 决策契约。
- `human-approval`: 限定为 `ask` 结果的交互适配，不再自行判断 Plan、Auto、YOLO 或风险。
- `tool-executor`: 移除内部审批和旧安全兜底，只执行已完成权限检查的调用。

## 影响范围

- 配置、持久化和 CLI：模式、规则来源、规则更新和模式切换命令全部变更。
- SessionContext：移除 WorkMode 和旧 capability 状态，增加 Claude 风格模式及 Plan 状态。
- NativeTool、MCP、Agent 和 tail call：统一接入工具权限检查和最终决策入口。
- 审批链路：重构 HumanApprovalPlugin、ApprovalPolicy、ApprovalService 和相关 capability 生命周期。
- 执行链路：重构 ToolCallOrchestrator、ToolExecutor 和直接调用边界，禁止绕过统一权限入口。
- 提示词和工具裁剪：仅作为行为优化，不能继续承担最终安全边界。
- 测试与规范：新增 Claude 参考行为夹具，更新所有受影响的权限、模式、审批、工具和执行器规范。
- 这是一次破坏性权限模型替换，不提供旧字段兼容读取、旧字段双写或旧模式别名。
