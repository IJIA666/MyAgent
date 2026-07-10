## 背景

真实执行链为：

`ToolCallOrchestrator -> BeforeTool hooks -> ApprovalEffectApplier -> ToolRegistry.callTool -> ToolExecutor.execute`

其中 `HumanApprovalPlugin` 在 BeforeTool 阶段负责获得 `SafetyCheckResult`，`ApprovalEffectApplier` 把用户决策转成 call/session/persistent 效果，`ToolExecutor` 只负责领取一次性能力并调用内建工具。当前故障只发生在安全评估来源：插件从 `ToolRegistryPort.getTool()` 得到纯元数据，却把它当成带 `checkSafety()` 的运行时工具对象。

现有 `SafetyCheckResult` 已完整表达 `pass | suspend | deny`，并包含 `message`、`safePrefix`、`targetPath`、`resources` 和 `operation`。因此不需要再创建第二套 `SafetyDecision`，也不应改变已经正确的授权和执行生命周期。

## 目标与非目标

**目标：**

- 用显式 `ToolPolicyPort` 替代 `HumanApprovalPlugin` 的运行时方法探测。
- 让内建策略评估调用真实 `NativeTool.checkSafety(args, sessionContext)`。
- 让外部 MCP 工具拥有可识别来源的保守策略结果。
- 保持 `ApprovalPolicy`、`pendingGrant`、能力注册/领取/消费和用户交互语义不变。
- 用真实组合测试证明生产路径上的 pass、deny、suspend 均可达。

**非目标：**

- 不恢复 `getTool(): NativeTool`，不重新引入 virtual MCP。
- 不新增与 `SafetyCheckResult` 重复的数据模型。
- 不新增 MCP trust 等级、配置 UI 或自动放行策略。
- 不修改 `ToolExecutor` 的能力领取语义。
- 不把策略决策写回运行时缓存或持久化存储。
- 不顺带重构资源锁、备份、AfterTool 或日志系统。

## 架构决策

### 决策 1：复用并提升现有安全决策类型

将 `SafetyCheckResult` 和 `SafetyOperation` 移到 `src/ports/shared/tool-policy.ts`，`plugin-types.ts` 只做类型 re-export。这样 `ToolPolicyPort`、内建工具、审批插件都使用同一数据模型，避免在 `status`/`action`、`message`/`reason` 之间做无价值映射。

```typescript
export interface ToolPolicyCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface ToolPolicyPort {
  evaluate(
    call: ToolPolicyCall,
    sessionContext: SessionEventPort,
  ): Promise<SafetyCheckResult>;
}
```

`SessionEventPort` 作为独立参数传入，而不是塞进可序列化调用数据中。原因是现有 `checkSafety()` 必须读取会话白名单和工作模式；如果只传工具名、参数和模式，session grant 将无法被识别。

### 决策 2：策略来源由适配器路由，插件不判断工具来源

`HumanApprovalPlugin` 只知道工具调用，不负责判断它是内建还是 MCP。适配器层建立 `ToolPolicyRouter`：

1. 先在内建策略映射中按名称查找。
2. 未命中时查询 `McpToolManager` 缓存的外部工具描述。
3. 两者均未命中时返回 `deny`，因为这代表模型请求了目录中不存在的工具。

这避免为插件新增 `source`、`serviceId` 等它无法可靠构造的字段。

### 决策 3：内建策略适配器接收同一批 `NativeTool[]`

`ToolRegistry` 当前在构造函数中调用 `buildNativeTools()`，随后用同一批对象构造 `ToolCatalog`、`ToolExecutor` 和 `ToolAccessMetadataProvider`。变更后同一数组还用于构造 `BuiltinToolPolicyAdapter`：

```typescript
const nativeTools = buildNativeTools(options);
this.catalog = new ToolCatalog(nativeTools, mcpManager);
this.executor = new ToolExecutor(this.catalog);
this.metadataProvider = new ToolAccessMetadataProvider(nativeTools);
this.policyPort = new ToolPolicyRouter(
  new BuiltinToolPolicyAdapter(nativeTools),
  new ExternalToolPolicyAdapter(mcpManager),
);
```

`BuiltinToolPolicyAdapter` 自己持有 `Map<string, NativeTool>`，命中后原样返回 `tool.checkSafety(call.args, sessionContext)` 的 `SafetyCheckResult`。它不得依赖 `ToolRegistryPort.getTool()`，也不需要泄漏 `ToolCatalog`。

`ToolRegistry` 可以向组合根暴露只读的 `policyPort`，但 `ToolRegistryPort` 本身不增加策略方法；核心层继续依赖两个独立端口。

### 决策 4：外部 MCP 保持保守挂起，不引入伪信任

`McpToolManager.getMcpTools()` 在建立 `toolRouter` 时，同时缓存：

- tool name
- server name
- 受支持的 annotations 字段（如存在）

`McpManagerPort` 使用端口层自有的只读 descriptor 类型，只复制 `readOnlyHint`、`destructiveHint`、`idempotentHint`、`openWorldHint` 等标准字段，不直接暴露 MCP SDK 类型，避免 driven port 依赖具体适配器库。

`ExternalToolPolicyAdapter` 对已经注册的 MCP 工具一律返回 `status: 'suspend'`，并产生：

- `resources: []`
- `operationCategory: 'external-tool'`
- 包含 server、工具名及 annotations 风险提示的 `message`/`summary`

annotations 只影响提示文本。例如 `destructiveHint: true` 可以增强警告，但 `readOnlyHint: true` 不能自动放行，因为 MCP 规范明确说明这些字段只是提示。

外部 MCP 没有 `ToolAccessMetadataProvider` 中的可信资源提取器，`ApprovalPolicy.resolve()` 会沿用现有 untrusted 分支，只提供 call/deny。用户批准后产生绑定 `toolCallId + toolName + argumentsDigest` 的精确一次性能力；空 resources 不代表目录授权，也不会写入 session/persistent 白名单。

由于外部 MCP 不经过 `ToolExecutor`，`ToolRegistry` 的 MCP 分支必须在调用 `callMcpTool()` 前通过显式 `CallCapabilityPort` 领取该能力，并要求领取结果不为 `null`。空数组表示“精确调用已获批但没有本地路径资源”，与“没有 capability”不同。领取失败说明调用 ID、工具名、参数摘要或状态不匹配，必须拒绝远端执行。

未注册的工具返回 `deny`，不会弹出一个无法执行的审批请求。

### 决策 5：审批插件只替换评估来源

`HumanApprovalPlugin.beforeToolMiddleware()` 的变更限定为：

1. 从 `HookContext.toolCall` 构造 `ToolPolicyCall`。
2. 调用 `toolPolicyPort.evaluate(call, sessionContext)`。
3. 继续按现有 `SafetyCheckResult.status` 分流。
4. `suspend` 继续调用现有 `buildSafetyOperation()`、`ApprovalPolicy.resolve()` 和 `ApprovalPolicy.mapChoiceToEffect()`。

不得新增“把策略结果写回端口缓存”的流程。策略评估是无状态查询，授权状态仍归 `SessionContext`、`ApprovalService` 和 `AuthorizationState` 管理。

### 决策 6：保持能力生命周期和执行时序

现有正确时序必须保持：

1. BeforeTool 得到安全结果。
2. 用户批准后，`ApprovalEffectApplier` 注册 call capability 或写入 session/persistent 效果。
3. `ToolExecutor.execute()` 在执行内建工具前调用 `claimCapability(toolCallId, toolName, args)`。
4. 工具通过 `ToolExecutionContext` 检查已领取资源或通过会话白名单。
5. `ToolCallOrchestrator` 在 finally 中调用 `consumeCapability(toolCallId)`。

外部 MCP 不经过 `ToolExecutor`，因此由 `ToolRegistry` 的 MCP 分支在远端调用前 claim capability；随后仍由编排器 finally 消费。该能力对外部 MCP 的意义是“本次精确调用已获批准”，不是文件路径授权。

为避免适配器继续假设具体 `SessionContext`，新增最小 `CallCapabilityPort`，暴露 `claimCapability(toolCallId, toolName, args)` 和 `hasClaimedResource(toolCallId, access, normalizedPath)`。前者供内建与外部执行边界领取能力，后者供 `secureResolveReadPath` / `secureResolveWritePath` 验证已领取资源。`ToolRegistryPort.callTool()`、`ToolExecutor.execute()` 和 `ToolExecutionContext.sessionContext` 在类型上组合 `SessionEventPort & CallCapabilityPort`；内建工具行为不变，外部 MCP 则首次获得确定性的领取边界。

本变更不新增 `ToolExecutor.claimCapability()`，因为该方法不存在；也不让执行器直接读取策略结果。

### 决策 7：主调用与 tail call 每次独立评估

tail call 已生成独立 `toolCallId` 并重新执行 BeforeTool 管线。它应基于自身名称和参数重新调用 `ToolPolicyPort`，不得复用主调用的策略结果或能力。AfterTool 不做新的前置授权评估。

## 风险与缓解

| 风险 | 缓解措施 |
| :--- | :--- |
| 提升共享类型导致导入变更较多 | `plugin-types.ts` 保留 re-export，调用方可渐进迁移 |
| 内建目录和策略映射发生漂移 | 两者必须由同一批 `NativeTool[]` 构造，并增加组合测试 |
| MCP annotations 被误用为信任事实 | 规格明确只允许改变文案；测试断言 `readOnlyHint` 不会产生 pass |
| 外部 MCP 空资源 capability 被误解为路径授权 | 规格明确它只绑定精确 call，不允许 session/persistent，也不绕过路径守卫 |
| 外部 MCP 注册能力后未经过 ToolExecutor 领取 | MCP 调用分支必须通过 CallCapabilityPort claim，失败时拒绝远端执行 |
| 测试再次使用过强替身 | 组合测试必须使用生产 `ToolRegistry.policyPort`；插件单测仅 mock `ToolPolicyPort` 公开契约 |

## 已决事项

- 使用现有 `WorkMode`/`SessionEventPort` 语义，不引入不存在的 `SessionMode`。
- 本变更不增加 MCP trust 配置；可信来源和自动放行需要独立探索。
- 不修改资源锁和备份范围；它们仍按现有工具元数据和参数运行。
- 不修改 `ToolExecutor` 和能力状态机，只验证现有时序未回归。
