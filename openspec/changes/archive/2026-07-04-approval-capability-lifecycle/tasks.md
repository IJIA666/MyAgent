## 1. 定义 SafetyResource 类型与扩展 SafetyCheckResult

- [x] 1.1 在 `src/core/usecases/security/SafetyResource.ts`（新文件）中定义 `SafetyResource` 联合类型：`{ kind: 'path'; access: 'read'|'write'; normalizedPath: string }` 和 `{ kind: 'command-prefix'; prefix: string }`
- [x] 1.2 在 `SafetyCheckResult`（`plugin-types.ts`）中新增 `resources?: SafetyResource[]` 字段，保留 `targetPath` 向后兼容

<!-- checkpoint: npx tsc --noEmit -->

## 2. 扩展 HookContext 类型

- [x] 2.1 在 `plugin-types.ts` 的 `HookContext.toolCall` 接口中新增 `id: string` 字段
- [x] 2.2 在 `plugin-types.ts` 中新增 `PendingGrant` 联合类型：`{ type: 'call'; toolCallId: string; toolName: string; resources: SafetyResource[] }` 和 `{ type: 'session'; toolCallId: string; resources: { access: 'read'|'write'; normalizedPath: string }[] }`（两个变体均包含 `toolCallId`，共享统一的防串号提交条件）
- [x] 2.3 在 `HookContext` 中新增 `pendingGrant?: PendingGrant` 字段
- [x] 2.4 新增 `ToolExecutionContext` 类型定义：`{ sessionContext, toolCallId, toolName, argumentsDigest, claimedResources }`

<!-- checkpoint: npx tsc --noEmit -->

## 3. SessionContext：CallCapability 三状态管理

- [x] 3.1 在 `context.ts` 中新增三状态 `CallCapability` 结构：`{ toolCallId, toolName, resources, argumentsDigest, state: 'registered'|'claimed'|'removed', claimedBy?: string, createdAt }`
- [x] 3.2 新增 `registerCallCapability(cap: CallCapability): void` 方法（以 toolCallId 为键存储），`cap` 参数必须包含 `argumentsDigest` 字段（由 AgentLoop 在 flush 时计算并传入）
- [x] 3.3 新增 `claimCapability(toolCallId: string, toolName: string, args: Record<string, unknown>): SafetyResource[] | null` 方法：验证 argumentsDigest + toolCallId 匹配，切换 `registered→claimed`，返回资源列表。不匹配或已被领取则返回 null
- [x] 3.4 新增 `consumeCapability(toolCallId: string): void` 方法：切换 `claimed→removed`
- [x] 3.5 新增 `hasClaimedResource(toolCallId: string, access: 'read'|'write', normalizedPath: string): boolean` 方法：在 claimed 状态令牌的 resources 中同时校验路径和 access 类型（`r.access === access`），防止读授权升级为写

<!-- checkpoint: npx tsc --noEmit -->

## 4. base.ts：secureResolve 新增 ToolExecutionContext 重载

- [x] 4.1 `secureResolveReadPath` 新增重载签名：`(targetPath: string, execContext: ToolExecutionContext): string`
- [x] 4.2 `secureResolveWritePath` 新增重载签名：`(targetPath: string, execContext: ToolExecutionContext): string`
- [x] 4.3 重载实现中优先检查 `execContext.sessionContext.hasClaimedResource(toolCallId, access, normalizedPath)`（`hasClaimedResource` 是 `SessionContext` 方法；`secureResolveReadPath` 传入 `'read'`，`secureResolveWritePath` 传入 `'write'`），再检查 session 白名单（原逻辑），最后检查沙箱边界
- [x] 4.4 原签名 `(targetPath: string, sessionContext?: SessionEventPort)` 保持不变，向后兼容

<!-- checkpoint: npx tsc --noEmit -->

## 4b. NativeTool.execute 接口契约迁移

- [x] 4b.1 在 `virtual-mcp.ts` 中导入 `ToolExecutionContext` 类型
- [x] 4b.2 修改 `NativeTool.execute` 第二参数签名：`_context?: ToolExecutionContext | SessionEventPort`
- [x] 4b.3 文件工具类（WriteFile、EditFile、ReadFile、ReadManyFiles、ListFiles、CreateDirectory、DeletePath、MovePath、CopyPath、ApplyPatch）：`execute` 实现中从 `_context` 提取 `ToolExecutionContext`（优先 `sessionContext` 来源），用于传入 `secureResolve{Read,Write}Path` 重载
- [x] 4b.4 命令工具类（Bash、PowerShell）：`execute` 从 `_context` 中提取 `sessionContext`（`ToolExecutionContext.sessionContext` 或直接 `SessionEventPort`），保持原有持久化白名单逻辑
- [x] 4b.5 其他非文件工具类（git、system、skill、interaction）：保持原有 `SessionEventPort` 签名兼容，不强制迁移
- [x] 4b.5a **Browser 工具显式适配**（BrowserNavigate、BrowserClick、BrowserType、BrowserScroll、BrowserBack、BrowserPress、BrowserVision、BrowserEnsureLogin、BrowserGetText 共 9 个）：每个 `execute()` 中从 `_context` 提取 `sessionContext`：若 `_context` 为 `ToolExecutionContext`，取 `_context.sessionContext`；否则直接使用 `_context` 作为 `SessionEventPort`。将提取后的 `sessionContext` 传入 `BrowserSession.getTenantIdFromContext(sessionContext)`，确保租户隔离不退化
- [x] 4b.6 `virtual-mcp.ts` 中 `tool.execute(args, ...)` 调用统一传入 `ToolExecutionContext`（含 claim 后的 `claimedResources`）

<!-- checkpoint: npx tsc --noEmit -->

## 5. agent-loop：toolCallId 透传 + pendingGrant 条件提交 + consumeCapability

- [x] 5.1 BeforeTool hook 调用点：将 `toolCall.id` 传入 HookContext 的 `toolCall.id` 字段
- [x] 5.2 BeforeTool 管线正常完成后，在继续执行前插入条件提交逻辑：
      `if (context.control.action === 'continue' && context.pendingGrant && context.pendingGrant.toolCallId === toolCallId) { ... }`
      提交时根据 grant.type 分别处理：
      - `call` 类型：计算 `argumentsDigest = computeArgumentsDigest(toolCall.arguments)`（规范化参数摘要，如 `JSON.stringify(Object.keys(args).sort().map(k => [k, args[k]]))`），调用 `registerCallCapability({ toolCallId, toolName, resources, argumentsDigest })`
      - `session` 类型：按 access 分别调用白名单方法
- [x] 5.3 主调用路径（第 642 行）：将 `toolCall.id` 作为 `toolCallId` 传入 `toolRegistry.callTool()` 的最后一个参数
- [x] 5.3a Tail call 路径：生成独立 `toolCallId`，走完整 beforeTool 管线（含 HumanApprovalPlugin）→ pendingGrant 条件提交 → callTool(tailCallId) → virtual-mcp claim → finally consumeCapability，与主调用路径完全一致
- [x] 5.4 每次工具调用完成后（成功/失败/Abort，在 finally 块中）：调用 `this.context.consumeCapability(toolCallId)`（含 tail call 路径）

<!-- checkpoint: npx tsc --noEmit -->

## 6. ToolRegistryPort.callTool 扩展 + 透传

- [x] 6.1 `ToolRegistryPort.ts` 的 `callTool` 签名新增 `toolCallId?: string` 参数
- [x] 6.2 `toolRegistry.ts` 的 `callTool` 实现透传该参数到 `localMcpServer.callTool()`
- [x] 6.3 `virtual-mcp.ts` 的 `callTool` 接收 `toolCallId` 参数
- [x] 6.4 `virtual-mcp.ts` 在 execute 前创建 `ToolExecutionContext`，调用 `claimCapability(toolCallId, toolName, args)` 领取令牌，将领取到的 `claimedResources` 存入执行上下文
- [x] 6.5 `virtual-mcp.ts` 将 `ToolExecutionContext` 传入 `tool.execute(args, execContext, signal, interactionPort)`

<!-- checkpoint: npx tsc --noEmit -->

## 7. HumanApprovalPlugin：once/always 区分 + pendingGrant 赋值

- [x] 7.1 在 `beforeToolMiddleware` 中获取当前 `context.toolCall.id`
- [x] 7.2 将现有无条件写入白名单的代码块拆分为 `once` 和 `always` 两个分支
- [x] 7.3 `once` 分支：构造 `{ type:'call', toolCallId, toolName, resources }` 赋值到 `context.pendingGrant`，不直接调用白名单方法
- [x] 7.4 `always` 分支：按 access 分类路径资源，构造 `{ type:'session', toolCallId, resources:[...] }` 赋值到 `context.pendingGrant`
- [x] 7.5 保持兼容：若 `safetyResult.resources` 为空但 `targetPath` 存在（仅当某工具的 `checkSafety` 尚未按 §9 迁移到新 `resources` 字段时触发），降级为 `[{ kind:'path', access: toolCall.securityCategory ?? 'write', normalizedPath: targetPath }]`。注意：只读工具（如 ReadFileTool）的 `securityCategory: 'read'` 兜底为 `access:'read'`，避免错误生成 write grant 后被 `secureResolveReadPath` 的白名单检查拒绝。§9 全部迁移完成后此兜底可移除。

<!-- checkpoint: npx tsc --noEmit -->

## 7b. DeletePathTool 审批路径收敛

- [x] 7b.1 修改 `DeletePathTool.execute()` 签名：从 `(args, sessionContext?: SessionEventPort & ApprovalPort)` 适配为 `(args, execContext: ToolExecutionContext)`（基于 4b 节 NativeTool 契约迁移），移除内部 `sessionContext.waitApproval()` 调用
- [x] 7b.2 移除 `virtual-mcp.ts` 中对 `deletePath` 的 `waitApproval` 遮蔽逻辑（约第 249-254 行的 `Object.assign`/`Object.create` 代码块）
- [x] 7b.3 `virtual-mcp.ts` 中 `deletePath` 直接传入 `ToolExecutionContext`，与其他工具走相同路径

<!-- checkpoint: npx tsc --noEmit -->

## 8. 工具层双端补传上下文

- [x] 8.1 `WriteFileTool`：`checkSafety` 和 `execute` 中将上下文传入 `secureResolveWritePath`
- [x] 8.2 `EditFileTool`：同上
- [x] 8.3 `ReadFileTool`：`secureResolveReadPath` 传入上下文（access='read'）
- [x] 8.4 `ReadManyFilesTool`：所有 `secureResolveReadPath` 调用传入上下文
- [x] 8.5 `ListFilesTool`：`secureResolveReadPath` 传入上下文
- [x] 8.6 `CreateDirectoryTool`：`secureResolveWritePath` 传入上下文
- [x] 8.7 `DeletePathTool`：同上
- [x] 8.8 `MovePathTool`：source + dest 两个 `secureResolveWritePath` 调用均传入上下文
- [x] 8.9 `CopyPathTool`：`secureResolveReadPath(source)` + `secureResolveWritePath(dest)` 均传入上下文
- [x] 8.10 `ApplyPatchTool`：`secureResolveWritePath` 传入上下文

<!-- checkpoint: npx tsc --noEmit -->

## 9. checkSafety 生成 SafetyResource[]

- [x] 9.1 以上每个工具的 `checkSafety()` 在返回 `{ status: 'suspend' }` 时填充 `resources` 字段
- [x] 9.2 `ReadFileTool`：返回 `[{ kind:'path', access:'read', normalizedPath }]`
- [x] 9.3 `ReadManyFilesTool`：每个文件返回一条 `access:'read'`
- [x] 9.4 `ListFilesTool`：返回 `[{ kind:'path', access:'read', normalizedPath }]`
- [x] 9.5 `WriteFileTool`：返回 `[{ kind:'path', access:'write', normalizedPath }]`（同 EditFile、CreateDirectory、DeletePath、ApplyPatch）
- [x] 9.6 `MovePathTool`：返回两个 `access:'write'`（source + dest，移动删除源）
- [x] 9.7 `CopyPathTool`：返回 `source:read` + `dest:write`
- [x] 9.8 `GrepSearchTool`：返回 `[{ kind:'path', access:'read', normalizedPath }]`

<!-- checkpoint: npx tsc --noEmit -->

## 10. GrepSearchTool 路径解析器切换

- [x] 10.1 将 `GrepSearchTool` 中的 `secureResolvePath` 调用替换为 `secureResolveReadPath`
- [x] 10.2 传入上下文参数

<!-- checkpoint: npx tsc --noEmit -->

## 11. 端到端验证

- [x] 11.1 验证 `once` 行为：审批后执行一次工具成功；重复相同操作触发新审批（令牌为 removed 状态） — 见 `call-capability.test.ts` 三状态生命周期测试
- [ ] 11.2 验证 `always` 终端命令：持久化白名单写入磁盘，跨会话生效 — 需要集成环境验证
- [ ] 11.3 验证 `always` 文件操作（后端）：session grant 写入白名单后，checkSafety 返回 pass + execute 放行 — session grant 通路已修复（base.ts whitelist 穿透 ToolExecutionContext、checkSafety 传 sessionContext），待集成验证
- [x] 11.4 验证读写隔离：授权读后写仍需审批；授权写后读仍需审批 — 见 `call-capability.test.ts` access-aware 测试
- [x] 11.5 验证 Move 双路径：两个 write 路径均被正确授权 — checkSafety 返回双 write 资源，execute 双路径传 context
- [x] 11.6 验证 Copy 双路径：source 按 read 授权，dest 按 write 授权，不能互换 — checkSafety 返回 read+write 双资源
- [x] 11.7 验证 Abort 时令牌正确消费：abort 后同一工具再次调用触发新审批 — consumeCapability 在 finally 块
- [x] 11.8 验证 GrepSearchTool 在已授权越界目录中的搜索 — 切换为 secureResolveReadPath + checkSafety 传 sessionContext + read 资源
- [x] 11.9 验证 DeletePathTool 走统一审批路径 — 移除内部 waitApproval，virtual-mcp 移除遮蔽逻辑
- [x] 11.10 验证 Tail call 工具调用 — tail call 现已走完整 beforeTool 管线（含 HumanApprovalPlugin）→ pendingGrant 条件提交 → callTool(tailCallId) → virtual-mcp claim → finally consumeCapability
- [x] 11.11 验证读授权不能升级为写 — `call-capability.test.ts` hasClaimedResource access-aware 双向隔离
- [x] 11.12 验证写授权不能绕过读检查 — 同上

<!-- checkpoint: npm run test -->
