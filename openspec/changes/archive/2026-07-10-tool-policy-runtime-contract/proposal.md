## 改造原因

统一工具运行时迁移后，`ToolRegistryPort.getTool()` 只返回 `ToolMetadata`，但 `HumanApprovalPlugin` 仍尝试从该返回值探测并调用 `checkSafety()`。由于生产返回值不包含该方法，所有内建工具都会错误进入“未知工具，默认挂起”分支；现有测试则通过 `as unknown as` 构造了公开端口不可能返回的对象，掩盖了真实组合路径的断裂。

外部 MCP 工具同样缺少显式策略入口：`McpToolManager` 在转换工具定义时没有保留 server 身份和 annotations，策略层只能把它们当成完全未知工具。需要把“工具目录查询”和“安全策略评估”拆成两个明确契约，同时保持现有审批效果、能力令牌和执行时序不变。

## 变更内容

1. **新增 `ToolPolicyPort`**
   - 接收只读的工具调用描述和当前 `SessionEventPort`。
   - 直接返回现有 `SafetyCheckResult`，不再新造与其重复的 `SafetyDecision`。

2. **将安全决策类型提升到共享端口层**
   - 把 `SafetyCheckResult`、`SafetyOperation` 移至 `src/ports/shared/`。
   - `plugin-types.ts` 保留类型 re-export，避免一次性扩大调用方迁移范围。

3. **内建工具策略适配**
   - 策略适配器接收与 `ToolCatalog` 相同的 `NativeTool[]`，按名称调用真实工具的 `checkSafety(args, sessionContext)`。
   - 禁止通过 `ToolRegistryPort.getTool()` 或类型断言重新取得 `NativeTool`。

4. **外部 MCP 工具策略适配**
   - `McpToolManager` 缓存工具所属 server，并把受支持的 annotations 字段复制到端口层本地描述类型，供策略适配器查询。
   - 已注册的外部 MCP 工具统一返回 `suspend`；annotations 只补充审批文案，不能触发自动放行。
   - 外部工具没有可信资源提取器时，继续复用 `ApprovalPolicy` 的 call/deny 限制，不生成 session 或 persistent 授权。
   - 本变更不新增 MCP trust 配置，避免在没有安装来源、配置 UI 和迁移语义的情况下改变现有 MCP 可用性。

5. **`HumanApprovalPlugin` 改为消费策略端口**
   - 插件不再运行时探测 `checkSafety`。
   - `pass`、`deny`、`suspend` 后续仍复用现有 `ApprovalPolicy`、`pendingGrant` 和 `persistentRuleEffect` 流程。

6. **保持能力令牌与执行边界不变**
   - `ApprovalEffectApplier` 继续在 BeforeTool 后注册授权。
   - `ToolExecutor.execute()` 继续在工具执行前 claim 能力。
   - 外部 MCP 分支在调用 `McpToolManager.callMcpTool()` 前必须 claim 精确 call capability；领取失败时不得执行远端工具。
   - `ToolCallOrchestrator` 继续在 finally 中 consume 能力。
   - 本变更不修改 `ToolExecutor` 的职责，也不把策略结果缓存到执行器。

7. **补齐真实组合测试**
   - 使用生产 `ToolRegistry` 暴露的策略端口和真实内建工具覆盖 pass、deny、suspend。
   - 重写通过 `as unknown as` 注入 `checkSafety` 的测试。
   - 覆盖外部 MCP 已注册、未知工具和 annotations 文案三条路径。

## 业务能力

### 新增业务能力

- `tool-policy-port`：统一的工具安全评估端口，复用现有安全决策数据模型，并明确运行时会话上下文的传递方式。
- `external-tool-policy-adapter`：为外部 MCP 工具提供保守、可识别来源的审批前策略。

### 修改业务能力

- `human-approval`：`HumanApprovalPlugin` 从“探测工具对象方法”改为“消费 `ToolPolicyPort` 结果”，对用户的审批交互和授权效果语义保持不变。

## 影响范围

- `src/ports/shared/`：共享安全决策类型和工具策略调用类型。
- `src/ports/driven/security/ToolPolicyPort.ts`：新增策略端口。
- `src/ports/driven/session/CallCapabilityPort.ts`：显式定义执行边界领取一次性能力及校验已领取资源的端口，替代对具体 `SessionContext` 的隐式假设。
- `src/adapters/tools/`：内建策略适配器、外部 MCP 策略适配器和策略路由。
- `src/adapters/tools/toolRegistry.ts`：使用同一批 `NativeTool[]` 构造目录、执行器和策略端口，向组合根暴露独立的 `policyPort`，并在外部 MCP 执行前领取 call capability。
- `src/adapters/tools/mcp-client.ts`、`McpManagerPort`：保留并查询外部工具的 server 与 annotations 描述。
- `src/core/usecases/plugins/HumanApprovalPlugin.ts`：注入并调用策略端口。
- `src/core/usecases/engine/session.ts`、`src/index.ts`：在组合根传入 `ToolPolicyPort`。
- 相关单元测试和真实组合测试。
