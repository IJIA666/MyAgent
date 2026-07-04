## 改造原因

当前审批系统存在两个相互纠缠的缺陷，导致授权语义失效：

1. **`once` 与 `always` 执行路径无区分**：`HumanApprovalPlugin` 对任何获批请求（不论 `once` 还是 `always`）都写入会话临时白名单。一旦 `sessionContext` 补传完成，`once` 会退化为会话放行。
2. **白名单传递断裂**：所有读写工具的 `execute()` 和 `checkSafety()` 调用 `secureResolve{Read,Write}Path(targetPath)` 时均未传递 `sessionContext`，即使白名单已写入，执行阶段仍因检查不到而抛"拒绝访问"。

**本 change 范围**：后端授权执行能力。文件工具的 `session` 授权在当前 CLI 中不可达（UI 不会为文件操作提供 `always` 选项），因此本 change 完成后的文件 `session` 授权仅对后续 `approval-policy-contract` change 接入 UI 后可见。终端命令的 `always` 语义保持现有的持久化白名单不变。

## 变更内容

1. **扩展 `HookContext.toolCall`**：增加 `id` 字段，使 BeforeTool 插件能获取当前 `toolCallId`。
2. **扩展 `agent-loop.ts` 调用链**：将 `toolCallId` 透传到 HookContext 和 `ToolRegistryPort.callTool()`。
3. **引入 `ToolExecutionContext`**：一个新的调用级上下文，携带 `sessionContext`、`toolCallId`、`toolName`、`argumentsDigest`，由 `virtual-mcp` 在 execute 边界创建并传入 `secureResolve{Read,Write}Path`。解决并发调用隔离问题。
4. **新增 `call` 级一次性授权机制**：tool-call-scoped 授权令牌，三状态状态机（`registered → claimed → removed`），绑定 `toolCallId` + 工具名 + 规范化资源。
5. **修正 `HumanApprovalPlugin` 授权执行路径**：`once` 走 call capability（不写白名单），`always` 写会话临时白名单。插件内收集授权效果，通过 Hook 返回值传递，由 AgentLoop 在三个条件全部成立时安全提交。
6. **所有文件读写工具补传 `sessionContext`**：`checkSafety()` 和 `execute()` 双端统一传递。
7. **`GrepSearchTool` 切换路径解析器**。
8. **`checkSafety()` 返回 `SafetyResource[]`**：按工具类型正确标注 read/write。
9. **`DeletePathTool` 审批路径收敛**：移除 `DeletePathTool.execute()` 内部的 `waitApproval` 调用，移除 `virtual-mcp.ts` 对 `deletePath` 的 `waitApproval` 遮蔽逻辑，使 `deletePath` 走统一的 `checkSafety → HumanApprovalPlugin` 路径。避免新旧两种审批路径并存导致的执行语义冲突。
11. **`NativeTool.execute` 接口契约迁移**：将 `NativeTool` 的 `execute` 第二参数从 `SessionEventPort` 扩展为联合类型 `ToolExecutionContext | SessionEventPort`。`virtual-mcp` 统一传入 `ToolExecutionContext`，需要 capability 检查的工具（所有文件工具）从中获取 `claimedResources`，不需要的工具（browser/git/system/skill/interaction）仍可访问 `execContext.sessionContext`。保留 `SessionEventPort` 分支确保非文件工具无需强制迁移。
12. **`hasClaimedResource` 增加 access 维度校验**：将 `hasClaimedResource(toolCallId, normalizedPath)` 改为 `hasClaimedResource(toolCallId, access, normalizedPath)`。`secureResolveWritePath` 重载检查 `hasClaimedResource(toolCallId, 'write', path)`，`secureResolveReadPath` 重载检查 `hasClaimedResource(toolCallId, 'read', path)`。防止读授权升级为写授权。
13. **`argumentsDigest` 注册链路闭环**：在 `registerCallCapability` 提交点（AgentLoop pendingGrant flush 逻辑）计算 `argumentsDigest`（规范化参数摘要），并与 `toolCallId`、`toolName`、`resources` 一同存入 `CallCapability`，确保 `claimCapability` 侧的摘要比对有可靠的注册源。
14. **Browser 工具显式适配 `ToolExecutionContext`**：`BrowserSession.getTenantIdFromContext()` 通过顶层 duck-typing 检查 `getTenantId`，`ToolExecutionContext` 将该方法封装在 `sessionContext` 子对象中，导致静默回退到 `'default'` 租户。Browser 工具（BrowserNavigate、BrowserClick、BrowserEnsureLogin 等 9 个）必须显式从 `ToolExecutionContext` 中提取 `sessionContext` 后传入。

**不涉及**：
- UI 层改动（facade.ts 选项渲染）
- `ApprovalPolicy` 中央策略服务
- `ApprovalPort` / `AgentEvent` 事件类型扩展
- 文件持久化授权
- Prompt 修改
- `SafetyOperation` 接口（将在 `approval-policy-contract` change 引入）
- 修改 `base.ts` 的现有方法签名（通过新增重载保留向后兼容）

## 业务能力

### 新增业务能力
- `approval-capability-lifecycle`: 调用级（call）和会话级（session）授权生命周期管理，含一次性令牌的三状态状态机和 `ToolExecutionContext`。

### 修改业务能力
- `human-approval-plugin`: once/always 执行路径严格区分，once 走 call capability，always 写入会话白名单。
- `file-read-tool`: `checkSafety()` 和 `execute()` 补传 `sessionContext`。
- `file-write-tool`: 同上。
- `file-edit-tool`: 同上。
- `directory-manager`: 同上（含 Move/Copy 双路径）。
- `apply-patch-tool`: 同上。
- `grep-search-tool`: 路径解析器切换为 `secureResolveReadPath`。

## 影响范围

- **`src/core/usecases/plugins/plugin-types.ts`** — `HookContext.toolCall` 扩展 `id`；新增 `pendingGrant` 返回字段
- **`src/core/usecases/engine/agent-loop.ts`** — toolCallId 透传 + 条件提交 grant
- **`src/core/usecases/plugins/HumanApprovalPlugin.ts`** — 授权执行路径重构，返回 pendingGrant（含 session 类型的 toolCallId）
- **`src/core/domain/context.ts`** — 新增 `CallCapability` 三状态管理、`ToolExecutionContext`
- **`src/ports/driven/tools/ToolRegistryPort.ts`** — callTool 扩展 `toolCallId`
- **`src/adapters/tools/toolRegistry.ts`** — 实现透传
- **`src/adapters/tools/virtual-mcp.ts`** — 创建 `ToolExecutionContext`，claim 令牌，传入 execute；移除 `deletePath` 的 `waitApproval` 遮蔽逻辑；`NativeTool` 接口第二参数扩展为 `ToolExecutionContext | SessionEventPort`
- **`src/adapters/tools/impl/filesystem/file-system.ts`** — 5 个工具的 checkSafety/execute
- **`src/adapters/tools/impl/filesystem/directory-manager.ts`** — 4 个工具；`DeletePathTool` 移除内部 `waitApproval` 调用，改为走统一的 `checkSafety → HumanApprovalPlugin` 路径
- **`src/adapters/tools/impl/filesystem/apply-patch.ts`** — ApplyPatchTool
- **`src/adapters/tools/impl/browser/browser-action.ts`** — 9 个 Browser 工具显式适配 `ToolExecutionContext`（提取 `sessionContext` 传入 `BrowserSession.getTenantIdFromContext()`）
- **`src/adapters/tools/impl/filesystem/search.ts`** — GrepSearchTool 解析器切换
- **`src/adapters/tools/impl/base.ts`** — 新增 `secureResolve{Read,Write}Path` 接受 `ToolExecutionContext` 的重载，保留原签名向后兼容
