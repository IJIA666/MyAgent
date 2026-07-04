### 需求: 一次性调用级授权令牌（call capability）
系统必须（MUST）提供调用级（call-level）的一次性授权机制，使用户选择的"单次放行"仅对当前工具调用生效，不写入任何白名单，执行完成后自动失效。令牌生命周期遵循三状态状态机：`registered → claimed → removed`。

#### 场景: once 决策注册令牌
- **WHEN** 用户在审批中选择"单次放行"，且 `HumanApprovalPlugin` 收到 `once` 决策，`AgentLoop` 条件满足后调用 `registerCallCapability`
- **THEN** 系统必须在 `SessionContext` 中注册一个 `state: 'registered'` 的 `CallCapability`，绑定 `toolCallId`、工具名称、规范化资源摘要和参数摘要（`argumentsDigest`）。`argumentsDigest` 由 `AgentLoop` 在 flush 逻辑中根据 `toolCall.arguments` 规范化计算（如 `JSON.stringify(sortedKeys(args))`）后存入，确保 `claimCapability` 侧的摘要比对有可靠的注册源

#### 场景: virtual-mcp 在 execute 边界 claim 令牌
- **WHEN** `virtual-mcp` 准备执行工具，使用当前 `toolCallId` 调用 `claimCapability`
- **THEN** 系统必须（MUST）查找 `state: 'registered'` 且 `toolCallId` 匹配的令牌，将其切换为 `state: 'claimed'`，并返回其资源列表供后续路径检查用。如果令牌已被其他调用 claim 或不存在，必须拒绝执行

#### 场景: 同一调用内多次路径检查
- **WHEN** 一次工具执行（如 `MovePathTool`、`ReadManyFilesTool`）需要在多个路径上调用 `secureResolve{Read,Write}Path`
- **THEN** 系统必须（MUST）通过 `sessionContext.hasClaimedResource(toolCallId, access, normalizedPath)` 检查已 claim 资源（同时校验路径和 read/write 类型，防止读授权升级为写授权），不得重复查找或消费令牌。该方法定义在 `SessionContext` 上，`ToolExecutionContext` 通过 `execContext.sessionContext` 访问。

#### 场景: 工具执行完成后移除令牌
- **WHEN** 工具执行成功、失败或 AbortSignal 触发
- **THEN** `agent-loop` 的 `finally` 块必须（MUST）调用 `consumeCapability(toolCallId)` 将令牌标记为 `state: 'removed'`

#### 场景: 令牌不可复用
- **WHEN** 令牌已被消费（`removed`）后，同一工具再次收到相同参数的新工具调用
- **THEN** 系统必须（MUST）拒绝执行并触发新的审批流程，令牌不可复用

#### 场景: 参数变更导致 token 验证失败
- **WHEN** 用户审批后，工具的调用参数发生变化（如 `targetPath` 被修改），导致 `argumentsDigest` 不匹配
- **THEN** `claimCapability` 必须返回 `null`，阻止执行，需重新发起审批

#### 场景: 并发调用隔离
- **WHEN** 多个工具调用同时发起审批并各自获得 `once` 授权
- **THEN** 每个调用获得独立的 `toolCallId`，各自的令牌独立注册/claim/consume，互不影响

### 需求: 会话级授权令牌（session capability）
系统必须（MUST）提供会话级（session-level）的授权机制，使用户选择的"始终放行"将规范化资源按访问类型（read/write）分别写入会话临时白名单。

#### 场景: always 决策写入会话白名单
- **WHEN** `AgentLoop` 条件满足后提交 `session` 类型的 `pendingGrant`
- **THEN** 系统必须（MUST）遍历所有路径资源，按 `access`（`read`/`write`）分别调用 `addTemporaryReadWhitelist` 或 `addTemporaryWriteWhitelist`。读授权和写授权严格隔离，不可交叉

#### 场景: session grant 跨多次调用生效
- **WHEN** 同一会话中，工具再次操作已授权到会话白名单的路径
- **THEN** 系统必须（MUST）在 `checkSafety()` 阶段通过 `secureResolve{Read,Write}Path(path, sessionContext)` 识别到已有 session grant，返回 `status: 'pass'`，跳过审批弹窗

#### 场景: 会话白名单在会话结束时自动清除
- **WHEN** 当前推理交互结束或会话被关闭
- **THEN** 系统必须（MUST）自动销毁该会话对应的所有临时白名单

### 需求: `ToolExecutionContext` 并发隔离
系统必须（MUST）引入调用级 `ToolExecutionContext` 上下文，用于在一次工具执行边界内传递授权状态，避免并发调用串号。

#### 场景: virtual-mcp 创建执行上下文
- **WHEN** `virtual-mcp.callTool` 被调用，传入 `toolCallId`
- **THEN** 系统必须（MUST）创建一个绑定 `toolCallId`、`toolName`、`sessionContext`、`argumentsDigest` 的 `ToolExecutionContext`，在执行边界 claim 一次性令牌

#### 场景: execute 和 secureResolve 使用执行上下文
- **WHEN** `tool.execute()` 内部调用 `secureResolveWritePath(path, execContext)`
- **THEN** 新重载必须（MUST）优先检查 `execContext.sessionContext.hasClaimedResource(toolCallId, access, normalizedPath)`（`hasClaimedResource` 是 `SessionContext` 的方法，通过 `ToolExecutionContext.sessionContext` 访问；read 或 write 由调用方 `secureResolveReadPath`/`secureResolveWritePath` 传入），再检查 session 白名单，最后检查沙箱边界。读授权不得通过写路径检查，反之亦然。

### 需求: 原子资源多路径展开
系统必须（MUST）支持多路径操作的原子资源展开，将 Move/Copy/ReadMany 等涉及多个路径的操作分解为独立的原子资源。

#### 场景: Move 展开为两个 write 资源
- **WHEN** `MovePathTool.checkSafety()` 返回 resources
- **THEN** 系统必须（MUST）将源路径和目标路径都按 `write` 授权返回，移动会删除源节点

#### 场景: Copy 展开为 read + write
- **WHEN** `CopyPathTool.checkSafety()` 返回 resources
- **THEN** 系统必须（MUST）将源路径按 `read` 授权，目标路径按 `write` 授权

#### 场景: ReadMany 展开为多个 read
- **WHEN** `ReadManyFilesTool.checkSafety()` 返回 resources
- **THEN** 系统必须（MUST）将每个文件路径都按 `read` 授权返回

### 需求: session 型 PendingGrant 包含 toolCallId
系统必须（MUST）确保 `session` 型 `PendingGrant` 包含 `toolCallId` 字段，与 `call` 型共享统一的防串号提交条件。

#### 场景: session grant 通过统一条件提交
- **WHEN** `HumanApprovalPlugin` 收集 `always` 决策的 session grant
- **THEN** 系统必须构造 `{ type: 'session', toolCallId, resources: [...] }`，其中 `toolCallId` 与 `call` 型一致，由 `AgentLoop` 在 `context.pendingGrant?.toolCallId === currentToolCallId` 条件下统一提交
- **THEN** 该字段防止 session grant 被其他并发工具调用误提交

### 需求: Tail call 工具调用走完整工具调用生命周期
系统必须（MUST）为 tail call 生成独立的 `toolCallId`，并走完整的 `callTool` → beforeTool 管线 → pendingGrant 提交 → 令牌生命周期。

#### 场景: Tail call 获得独立 toolCallId
- **WHEN** `agent-loop.ts` 执行 tail call
- **THEN** 系统必须为 tail call 生成独立的 `toolCallId`，传入 `toolRegistry.callTool()`，与主调用行为一致

#### 场景: Tail call 触发审批
- **WHEN** tail call 目标工具触发安全审查
- **THEN** 系统必须通过完整的 beforeTool 管线处理审批，`HumanApprovalPlugin` 可正常获取 `context.toolCall.id`，pendingGrant 可正常提交

### 需求: hasClaimedResource 必须校验 access 维度
系统必须（MUST）在 `hasClaimedResource` 中同时校验 `normalizedPath` 和 `access`（read/write），防止读授权升级为写授权。

#### 场景: 读授权不能通过写路径检查
- **WHEN** 工具调用 `secureResolveWritePath('/some/path', execContext)`，而令牌中仅包含 `{ kind:'path', access:'read', normalizedPath:'/some/path' }`
- **THEN** `hasClaimedResource(toolCallId, 'write', '/some/path')` 必须返回 `false`，拒绝执行

#### 场景: 写授权不能通过读路径检查
- **WHEN** 工具调用 `secureResolveReadPath('/some/path', execContext)`，而令牌中仅包含 `{ kind:'path', access:'write', normalizedPath:'/some/path' }`
- **THEN** `hasClaimedResource(toolCallId, 'read', '/some/path')` 必须返回 `false`

#### 场景: 匹配时路径+access 双重校验
- **WHEN** 令牌中包含 `{ kind:'path', access:'write', normalizedPath:'/some/path' }`，工具调用 `secureResolveWritePath('/some/path', execContext)`
- **THEN** `hasClaimedResource(toolCallId, 'write', '/some/path')` 返回 `true`，放行

### 需求: NativeTool.execute 接口契约迁移
系统必须（MUST）将 `NativeTool.execute` 的第二参数从 `SessionEventPort` 扩展为联合类型 `ToolExecutionContext | SessionEventPort`，并制定工具逐类迁移策略。

#### 场景: virtual-mcp 统一传入 ToolExecutionContext
- **WHEN** `virtual-mcp.callTool` 被调用
- **THEN** 系统必须（MUST）创建 `ToolExecutionContext`，并将其作为 `tool.execute()` 的第二参数传入，替代原 `SessionEventPort`

#### 场景: 文件工具从 ToolExecutionContext 获取 capability
- **WHEN** 文件工具（WriteFile、EditFile、ReadFile 等）的 `execute()` 收到 `ToolExecutionContext`
- **THEN** 工具必须从中提取 `claimedResources` 用于 `secureResolve{Read,Write}Path` 的 capability 检查

#### 场景: 非文件工具保持兼容
- **WHEN** 非文件工具（git、system、skill、interaction）的 `execute()` 收到 `ToolExecutionContext`
- **THEN** 工具仍可访问 `execContext.sessionContext` 获取原有会话级能力，无需感知 capability 机制
- **THEN** Browser 工具（BrowserNavigate、BrowserClick、BrowserEnsureLogin 等 9 个）不在"无需迁移"范围内：其 `BrowserSession.getTenantIdFromContext()` 通过顶层 duck-typing 检查 `getTenantId`，`ToolExecutionContext` 不直接暴露该方法，必须显式从 `execContext.sessionContext` 提取后传入，否则静默回退到 `'default'` 租户

### 需求: DeletePathTool 收敛到统一安全模型
系统必须（MUST）将 `DeletePathTool` 的审批收敛到统一的 `checkSafety → HumanApprovalPlugin` 路径，移除内部冗余的 `waitApproval` 调用。

#### 场景: DeletePathTool.checkSafety 返回统一挂起结果
- **WHEN** `DeletePathTool.checkSafety()` 检测到越界写入路径
- **THEN** 系统必须返回 `{ status: 'suspend', resources: [{ kind:'path', access:'write', normalizedPath }] }`，不自行调用 `waitApproval`

#### 场景: virtual-mcp 移除 deletePath 特殊遮蔽
- **WHEN** `virtual-mcp.ts` 准备调用 `DeletePathTool.execute()`
- **THEN** 系统不得再执行 `deletePath` 特殊的 `waitApproval` 遮蔽逻辑（`Object.assign` 原型链替换），所有工具的审批均由插件管线统一驱动

### 需求: 持久化规则授权效果（persistent rule effect）
系统必须（MUST）支持 `persistent` 类型的授权效果，用于将命令前缀规则持久化写入磁盘白名单，与 `call`（一次性令牌）和 `session`（会话白名单）并列。

#### 场景: AgentLoop 提交 persistent 效果
- **WHEN** `HumanApprovalPlugin` 返回 `persistent` 类型的授权效果，且 `AgentLoop` 在授权效果提交阶段匹配到该效果
- **THEN** 系统必须通过 `SecurityService.getInstance().saveSecurityAllowlist()` 将命令前缀规则追加到持久化白名单文件
- **THEN** `persistent` 效果仅对 `command-prefix` 资源类型生效，对其他资源类型降级为 `call`

#### 场景: persistent 与 call/session 互斥提交
- **WHEN** 一次审批决策同时满足多个效果（如 `session` + `persistent`）
- **THEN** `ApprovalPolicy.mapChoiceToEffect()` 必须（MUST）只返回单一效果类型，由策略层在 choice 级别做出选择
