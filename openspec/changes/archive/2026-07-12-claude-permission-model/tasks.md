## 1. 建立 Claude 权限行为基线

- [x] 1.1 在 `src/core/domain/permissions/` 和共享端口中定义 `PermissionMode`、`PermissionBehavior`、`PermissionRule`、`PermissionUpdate`、`PermissionDecision` 及工具内部 `passthrough` 类型，字段语义与 `openspec/changes/claude-permission-model/exploration.md` 一致。
- [x] 1.2 为 `PermissionDecision` 建立 `allow`、`ask`、`deny` 三种最终结果和结构化 `decisionReason`，禁止引入 `pass`、`suspend`、`PlanSideEffect` 或新的风险枚举。
- [x] 1.3 在 `test/core/` 下建立权限行为测试夹具目录，定义规则集合、PermissionMode、工具输入、预期决策和 PermissionUpdate 的可序列化格式。

<!-- checkpoint: npx tsc --noEmit -->

## 2. 实现规则存储、解析和更新

- [x] 2.1 新增 `PermissionRuleStore`，支持 `userSettings`、`projectSettings`、`localSettings`、`flagSettings`、`policySettings`、`cliArg`、`command`、`session` 来源，并明确每个来源的生命周期和可修改性。
- [x] 2.2 实现 `Tool`、`Tool(specifier)`、MCP server/tool、Agent 和路径规则的解析与规范化，保留 Bash/PowerShell 内容规则的原始输入供工具专属匹配器使用。
- [x] 2.3 实现固定的 `deny → ask → allow` 匹配顺序，验证规则具体程度不能覆盖行为优先级，工具级 deny 与内容级 deny 的外部行为分别保持一致。
- [x] 2.4 实现 `PermissionUpdate` 的 add/replace/remove/set 操作，将 once、session、persistent 授权映射到当前调用、`session` 来源和配置来源。
- [x] 2.5 在 `test/core/` 下覆盖工具级规则、内容规则、冲突优先级、MCP 规则、路径规则、来源生命周期和 PermissionUpdate 持久化结果。

<!-- checkpoint: npx vitest run test/core -->

## 3. 实现统一 ToolPermissionService

- [x] 3.1 新增 `ToolPermissionService`，按 Claude 顺序执行全局 deny/ask、工具 `checkPermissions`、工具级安全结果、bypass、allow、passthrough、dontAsk、auto 和 headless fallback。
- [x] 3.2 为 `checkPermissions(input, context)` 定义工具端口契约，允许工具返回 `allow`、`ask`、`deny`、`passthrough`，但只允许权限服务产生最终 `allow`、`ask`、`deny`。
- [x] 3.3 实现 `default`、`acceptEdits`、`plan`、`dontAsk`、`bypassPermissions` 的最终决策语义，显式 ask、deny 和 circuit breaker 不得被 bypass 覆盖。
- [x] 3.4 在 `test/core/` 下建立 ToolPermissionService 单元测试，覆盖工具拒绝、passthrough 转 ask、allow/ask/deny 冲突、dontAsk、acceptEdits 和 bypass 边界。

<!-- checkpoint: npx vitest run test/core -->

## 4. 重建模式状态与配置边界

- [x] 4.1 修改 `src/config/types.ts`、`src/config/loader.ts` 和 `src/adapters/tools/impl/system/terminal-config.ts`，删除 `WorkMode`、`workMode` 配置和环境变量解析，接入 `PermissionMode` 及规则配置。
- [x] 4.2 修改 `src/core/domain/context.ts`、`src/core/usecases/engine/session.ts`、`src/ports/driven/session/SessionEventPort.ts`、`src/ports/driving/ChatUseCase.ts` 和 `src/ports/driving/CliSessionUseCase.ts`，以会话级 `PermissionMode`、规则状态和 `prePlanMode` 替换旧状态。
- [x] 4.3 实现 `PermissionModeManager`，统一处理 CLI、会话恢复和控制消息的模式切换；进入 Plan 保存 `prePlanMode`，退出 Plan 恢复原模式。
- [x] 4.4 修改 `src/adapters/input/interface/commands/workmode.ts`、`commands/index.ts`、`command.ts`、`facade.ts` 和输入提示渲染，将旧 WorkMode 命令替换为统一 PermissionMode 选择器及 Claude 产品标签。
- [x] 4.5 在 `test/config`、`test/core` 和 `test/adapters` 中覆盖多会话隔离、Plan 进入/退出恢复、模式切换持久性和默认模式加载。

<!-- checkpoint: npx vitest run test/config test/core test/adapters -->

## 5. 迁移 NativeTool 的权限检查

- [x] 5.1 修改 `src/ports/shared/tool-policy.ts`、`src/adapters/tools/tool-types.ts`、`src/adapters/tools/builtin-tool-policy-adapter.ts`、`src/adapters/tools/external-tool-policy-adapter.ts` 和 `src/adapters/tools/tool-policy-router.ts`，删除 `ToolPolicyPort`、`SafetyCheckResult` 和 `SafetyOperation` 的最终决策职责。
- [x] 5.2 将 `src/adapters/tools/impl/system/terminal.ts` 的 `checkSafety`、WorkMode 分支、PlanSideEffect 和旧安全结果转换改为 Claude 风格 `checkPermissions`，保留 Bash/PowerShell 复合命令、wrapper 和只读命令的工具专属检查。
- [x] 5.3 将 `src/adapters/tools/impl/filesystem/file-system.ts`、`apply-patch.ts`、`directory-manager.ts`、`read-many-files.ts` 和 `search.ts` 的 `checkSafety` 与 WorkMode 分支迁移为 `checkPermissions`，保持路径和源文件编辑规则行为。
- [x] 5.4 将 `src/adapters/tools/impl/browser/browser-action.ts`、`git/git-show-diff.ts`、`git/git-show-log.ts`、`git/git-show-status.ts`、`interaction/ask-user-question.ts`、`skill/skill.ts` 和 `system/time.ts` 的安全检查逐一迁移为统一工具检查结果。
- [x] 5.5 为终端、文件系统、Git、浏览器、交互、Skill 和 MCP 工具补充工具级、内容级、路径级和 passthrough 测试，禁止工具读取 `PermissionMode` 做最终授权。

<!-- checkpoint: npx vitest run test/adapters test/contract -->

## 6. 迁移 MCP、Agent 和 OpenAI 工具适配

- [x] 6.1 修改 `src/adapters/tools/external-tool-policy-adapter.ts` 和 MCP 注册路径，将外部工具规范化为 `mcp__server` / `mcp__server__tool` 规则名称，不再生成 unknown capability 或旧 `SafetyCheckResult`。
- [x] 6.2 将 Agent/sub-agent 工具接入 `Agent(...)` 规则匹配，确保 deny、ask 和 Auto 分类器保护在子代理调用中生效。
- [x] 6.3 将 OpenAI tool call 的名称、参数和 toolCallId 适配到统一 ToolPermissionService 输入，保证 tail call 重新经过权限服务。
- [x] 6.4 在 `test/contract` 和 `test/integration` 增加 MCP server/tool、Agent 规则、未知注册工具、OpenAI tool call 和 tail call 的权限契约测试。

<!-- checkpoint: npx vitest run test/contract test/integration -->

## 7. 重构审批交互和规则复用

- [x] 7.1 删除 `src/core/usecases/security/ApprovalPolicy.ts`，并从 `src/core/usecases/engine/session.ts` 移除其组合根装配和注入。
- [x] 7.2 创建 PermissionPromptAdapter 替代原 HumanApprovalPlugin，只消费 ToolPermissionService 的 `ask`、message、decisionReason 和 PermissionUpdate 建议。
- [x] 7.3 修改 `src/core/usecases/plugins/plugin-types.ts`，删除 `SafetyCheckResult`、`SafetyOperation`、WorkMode 和 choice/effect 映射，改用 Claude 风格 PermissionDecision。
- [x] 7.4 删除 `src/ports/driven/session/CallCapabilityPort.ts` 作为权限授权端口的职责；将 once/session/persistent 选择转换为 PermissionUpdate，执行器防绕过上下文不得暴露为 capability。
- [x] 7.5 在 `test/core` 和 `test/integration` 覆盖 ask 展示、once/session/persistent 更新、deny/allow 不触发审批、显式 ask 在 bypass 下仍触发审批。

<!-- checkpoint: npx vitest run test/core test/integration -->

## 8. 实现 Auto 分类器与模式后处理

- [x] 8.1 新增 `AutoPermissionClassifier` 适配器，使用 MyAgent 的 OpenAI 调用接口实现 Claude 的 ask 后分类边界，分类器不得处理已经 deny 或显式 ask 保护的调用。
- [x] 8.2 实现进入 Auto 时危险 allow 规则剥离、离开 Auto 时规则恢复，并覆盖任意脚本解释器、任意 Agent 和等价宽范围规则。
- [x] 8.3 实现分类器不可用、拒绝次数达到限制、headless 无交互和 Plan 内 Auto 语义的失败路径，禁止失败时静默放行。
- [x] 8.4 修改 `src/core/usecases/engine/model-request-assembler.ts`，删除其对 Plan 的安全裁剪假设，仅保留提示和工具列表优化。
- [x] 8.5 在 `test/core` 和 `test/integration` 增加 Auto 允许、拒绝、分类器不可用、危险规则剥离、Plan/Auto 转换和 headless 场景测试。

<!-- checkpoint: npx vitest run test/core test/integration -->

## 9. 封装 ToolCallGateway 与 ToolExecutor

- [x] 9.1 修改 `src/adapters/tools/toolRegistry.ts`，将 NativeTool、MCP 和 tail call 的执行统一转入 ToolCallGateway，不再暴露可绕过权限服务的直接执行路径。
- [x] 9.2 创建 `ToolCallGateway` 统一网关框架，删除人工审批、旧安全兜底和 WorkMode 读取，只接受 Gateway 生成的不可伪造内部执行上下文。
- [x] 9.3 审计并确认 ToolExecutor 直接调用点已迁移至 Gateway、ToolRegistry、MCP 管理器和所有直接 ToolExecutor 调用点，迁移到 Gateway 或删除绕过路径。
- [x] 9.4 为未携带内部执行上下文的直接执行、已授权 Gateway 执行、单次执行和执行后 effect 记录增加契约测试。

<!-- checkpoint: npx tsc --noEmit -->

## 10. 删除旧权限链路并完成同构验收

- [x] 10.1 全仓删除 WorkMode/SafetyCheckResult 生产引用 生产引用、`PlanSideEffect`、`SafetyCheckResult`、`ApprovalPolicy` 和旧 `ToolPolicyPort` 决策语义的生产引用、导出和配置字段。
- [x] 10.2 全仓静态审计全部通过工具读取 `PermissionMode`、执行器内部人工审批、直接 ToolExecutor 调用和未经过 Gateway 的工具执行路径，逐项达到零残留标准。
- [x] 10.3 完成 Claude 参考行为夹具，至少覆盖工具级规则、内容规则、deny/ask/allow 冲突、Bash/PowerShell 复合命令、路径、MCP、Plan、Auto、dontAsk、bypass 和规则更新。
- [x] 10.4 更新 `openspec/specs/` 中 `approval-capability-lifecycle`、`approval-policy-contract`、`security-modes`、`cli-workmode-command`、`session-context-contract`、`tool-policy-port`、`human-approval` 和 `tool-executor` 主规范，删除旧需求并同步 Claude 同构需求。
- [x] 10.5 运行全量类型检查、权限相关单元测试、契约测试、集成测试和 OpenSpec 严格校验，确认新旧运行时链路不存在并行执行。

<!-- checkpoint: npx tsc --noEmit -->
<!-- checkpoint: npx vitest run -->
<!-- checkpoint: openspec validate --strict -->
