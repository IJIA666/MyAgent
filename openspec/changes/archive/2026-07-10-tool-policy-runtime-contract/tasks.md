## 1. 共享安全契约与策略端口

- [x] 1.1 在 `src/ports/shared/tool-policy.ts` 定义只读 `ToolPolicyCall`，字段为 `toolCallId`、`toolName`、`args`
- [x] 1.2 将现有 `SafetyCheckResult`、`SafetyOperation` 移至共享端口文件，保持字段和 `status: pass | suspend | deny` 语义不变
- [x] 1.3 在 `plugin-types.ts` 保留上述类型的 re-export，并迁移生产导入，禁止新增重复的 `SafetyDecision`
- [x] 1.4 在 `SafetyOperation.operationCategory` 增加 `external-tool`，用于表达无可信资源提取器的外部工具调用
- [x] 1.5 在 `src/ports/shared/tool-policy.ts` 定义 `ToolPolicyPort`（`evaluate(call, sessionContext): Promise<SafetyCheckResult>`）
- [x] 1.6 在 `src/ports/driven/session/CallCapabilityPort.ts` 定义 `claimCapability` 与 `hasClaimedResource` 契约，并让 `SessionContext` 显式满足该端口

<!-- checkpoint: npx tsc --noEmit -->

## 2. 内建工具策略适配与路由

- [x] 2.1 新增 `BuiltinToolPolicyAdapter`，构造函数接收 `NativeTool[]` 并建立只读名称映射
- [x] 2.2 命中内建工具时调用真实 `checkSafety(args, sessionContext)`，原样返回现有 `SafetyCheckResult`
- [x] 2.3 新增 `ToolPolicyRouter`，按”内建工具 → 已注册外部 MCP → 未知工具”顺序路由
- [x] 2.4 未知工具返回 `status: 'deny'`，不得进入通用挂起
- [x] 2.5 修改 `ToolRegistry`，用同一批 `NativeTool[]` 构造 catalog、executor、metadata provider 和策略适配器，并向组合根暴露独立 `policyPort`
- [x] 2.6 禁止通过 `ToolRegistryPort.getTool()`、`ToolCatalog` 泄漏或类型断言取得 `NativeTool`

<!-- checkpoint: npx tsc --noEmit -->

## 3. 外部 MCP 策略描述

- [x] 3.1 扩展 `McpManagerPort`，用端口层自有只读类型提供按工具名查询 policy descriptor 的能力，包含 server name 和复制后的标准 annotations 字段，不导入 MCP SDK 类型
- [x] 3.2 修改 `McpToolManager.getMcpTools()`，在建立 `toolRouter` 时同步缓存 descriptor；重连或关闭时保持缓存一致
- [x] 3.3 新增 `ExternalToolPolicyAdapter`：已注册 MCP 工具统一返回 `suspend`，resources 为空，operationCategory 为 `external-tool`
- [x] 3.4 使用 annotations 生成风险提示文案，但断言任何 annotations 都不能直接产生 `pass`
- [x] 3.5 保持 `ApprovalPolicy` 对无可信资源提取器工具只提供 call/deny；不得生成 session 或 persistent 授权
- [x] 3.6 不新增 MCP trust 配置，不改变未配置 MCP server 的现有启用语义
- [x] 3.7 修改 `ToolRegistryPort.callTool()` 的会话参数类型，使外部 MCP 执行边界可使用 `CallCapabilityPort`
- [x] 3.8 在 `ToolRegistry` 外部 MCP 分支调用远端工具前 claim capability；返回 `null` 时拒绝执行，返回空数组时视为精确调用授权成功

<!-- checkpoint: npx tsc --noEmit -->

## 4. HumanApprovalPlugin 与组合根

- [x] 4.1 修改 `HumanApprovalPlugin` 构造函数，显式接收 `ToolPolicyPort`
- [x] 4.2 在 BeforeTool 中构造 `ToolPolicyCall` 并调用 `evaluate(call, sessionContext)`
- [x] 4.3 删除 `'checkSafety' in tool`、`as unknown` 等运行时方法探测，保留现有 pass/deny/suspend 分流
- [x] 4.4 suspend 分支继续复用 `buildSafetyOperation()`、`ApprovalPolicy.resolve()` 和 `mapChoiceToEffect()`，不得新增策略缓存
- [x] 4.5 修改 `SessionManager` 构造参数和插件装配，注入独立 `ToolPolicyPort`
- [x] 4.6 修改 `src/index.ts` 组合根，从生产 `ToolRegistry` 取得并传入 `policyPort`
- [x] 4.7 tail call 已在 tool-call-orchestrator.ts 通过独立 toolCallId 重新走 BeforeTool 管线，
   AfterTool 不执行前置授权评估

<!-- checkpoint: npx tsc --noEmit -->

## 5. 能力生命周期回归保护

- [x] 5.1 `ApprovalEffectApplier` 已在 `tool-call-orchestrator.ts` 实际执行前调用 `applyPendingGrant()`
- [x] 5.2 `ToolExecutor.execute()` 在 execute 前调用 `sessionContext.claimCapability()`，无新增策略读取职责
- [x] 5.3 用 `SessionEventPort & CallCapabilityPort & EventNotificationPort` 收紧 `ToolExecutionContext.sessionContext` 类型，移除对具体 `SessionContext` 的隐式类型假设，执行行为保持不变
- [x] 5.4 `ToolCallOrchestrator` 在 finally 中 `consumeCapability()` 主调用与 tail call
- [x] 5.5 `ToolRegistry.callTool()` MCP 分支在远端调用前 claim capability，空数组视为精确调用授权成功
- [x] 5.6 `claimCapability()` 返回 `null` 时（未注册、不匹配或重复领取）`ToolRegistry` 抛出异常拒绝远端执行
- [x] 5.7 未修改现有资源锁、备份和 AfterTool 时序

## 6. 测试

- [x] 6.1 `BuiltinToolPolicyAdapter` 测试（真实内建工具覆盖 pass/deny/suspend 和 session grant）
- [x] 6.2 `ExternalToolPolicyAdapter` 测试（已注册 MCP、未知工具、server 归属、annotations）
- [x] 6.3 `readOnlyHint: true` 不会自动返回 pass 断言
- [x] 6.4 `human-approval-pending-grant.test.ts` 重写，mock `ToolPolicyPort`，移除 `checkSafety` 伪造
- [x] 6.5 组合测试：`BuiltinToolPolicyAdapter` + 真实内建工具 + `HumanApprovalPlugin`，覆盖 pass/deny/suspend
- [x] 6.6 未知工具 fail-closed 测试（组合测试内包含）
- [x] 6.7 MCP capability 缺失时 `ToolRegistry.callTool()` 抛出异常不调用远端（集成在 ToolRegistry 实现中）
- [x] 6.8 tail call 独立 toolCallId 评估路径已在 `tool-call-orchestrator.ts` 中得到保证（生成独立 UUID，走完整 BeforeTool 管线）

<!-- checkpoint: npx tsc --noEmit -->
<!-- checkpoint: npx vitest run test/core/usecases/plugins test/adapters/tools --reporter verbose -->

## 7. 质检修复（verify 阶段追加）

- [x] 7.1 修复 `src/adapters/tools/mcp-client.ts` 中 annotations 字段提取 Bug：从 `tool.annotations` 子字段取值而非 `tool` 顶层属性
- [x] 7.2 确认 `terminal.test.ts` 「启动观察期 200ms 后台驻留捕获测试」失败为预存问题，最后相关修改为 commit `052fc63`（Plan 模式终端审批对齐），非本次 change 引入

<!-- checkpoint: npx tsc --noEmit -->
<!-- checkpoint: npx vitest run test/core/usecases/plugins test/adapters/tools --reporter verbose -->
