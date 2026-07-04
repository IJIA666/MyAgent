## 修改需求

<!-- 以下为 openspec/specs/human-approval/spec.md 中"人机交互决策反馈闭环"需求的完整替换版本 -->

### 需求: 人机交互决策反馈闭环
系统必须（MUST）提供外部 UI/客户端回复审批决策的入口，并能根据反馈执行放行、单次拒绝、持久化始终放行以及联动级联安全熔断。

#### 场景: 用户明确拒绝
- **WHEN** 外部接收到挂起事件并在 UI 处理完毕后，调用 `ApprovalService.resolve` 且动作为 `deny` 时
- **THEN** 系统应唤醒挂起的执行流，自动向大模型注入"调用被插件拦截：User denied"的工具执行报错信息，且终端决不会发生任何物理动作。

#### 场景: 用户选择始终放行（MODIFIED）
- **WHEN** 外部调用 `ApprovalService.resolve` 且动作为 `always` 时
- **THEN** 对于终端命令操作（`execute_command`），系统应记录并持久化该命令或前缀至磁盘白名单，继续唤醒并执行该工具；下次遇到相同命令或前缀时不需再次弹出。此行为跨会话持久有效。
- **THEN** 对于文件操作（路径访问），系统必须在 `HumanApprovalPlugin.beforeToolMiddleware` 中将资源按 read/write 分别收集为 `session` 类型的 `PendingGrant`（包含 `toolCallId` 字段，与其他 grant 类型共享统一的防串号条件），在 `agent-loop` 的三个条件（管线正常完成 + control.action === 'continue' + grant.toolCallId 匹配）全部成立时，通过 `flushPendingGrant` 写入当前会话的临时白名单。此授权仅在本会话生命周期内有效。
- **THEN** 文件操作的 `session` 授权在当前 CLI 中暂不可达（UI 不为文件操作提供 `always` 选项），由后续 `approval-policy-contract` change 接入。

#### 场景: 用户选择单次放行（ADDED）
- **WHEN** 外部调用 `ApprovalService.resolve` 且动作为 `once` 时
- **THEN** 系统必须在 `HumanApprovalPlugin.beforeToolMiddleware` 中收集 `call` 类型的 `PendingGrant`（绑定 `toolCallId`、工具名和资源列表），在 `agent-loop` 条件满足时通过 `registerCallCapability` 注册一次性令牌。
- **THEN** 令牌以 `registered` 状态存入 `SessionContext`，由 `virtual-mcp` 在 execute 边界 claim 为 `claimed`，执行完成/失败/abort 后由 `agent-loop` 移除为 `removed`。
- **THEN** 令牌不写入任何白名单。

#### 场景: 会话级挂起队列的级联安全熔断
- **WHEN** 某一会话中有多个高危工具调用并发或串行挂起等待审批，且用户对其中某一个挂起请求显式驳回（resolve 动作为 deny）时
- **THEN** 系统必须（MUST）在唤醒退出当前被拒请求的同时，自动将当前会话下在挂起列表（`pendingRequests`）中等待的所有其他请求一并标记为"已中止"，彻底清除会话残留队列。
- **THEN** 系统必须向其余所有被中止的工具调用统一返回包含"中断重塑"上下文的安全阻断报错（如 `HaltedByReject: Operation rejected by user, and all subsequent pending actions have been cancelled.`），允许大模型在此基础上重新执行中断重塑（Halt & Re-plan）。
- **THEN** 此级联熔断动作只局限在被拒绝会话内部，对其他不同 `sessionID` 的并发会话挂起队列绝不产生任何影响。

#### 场景: 无主挂起防空与资源安全回收
- **WHEN** 智能体进入挂起审批状态但经过超过预设安全阈值（如 5 分钟）未得到任何交互层回复时
- **THEN** 系统应自动判定为决策 `deny`，唤醒底层继续大模型运转并返回被拒信息。

#### 场景: CI或测试环境强行 Bypass
- **WHEN** 系统处于自动化测试环境或配置有自动 `mockDecision` 的绕过策略时
- **THEN** 系统应在遇到审批请求时立即以自动放行态度返回，保障流水线的非交互性顺畅流转。

## 新增需求

### 需求: checkSafety 与 execute 双端上下文传递
系统必须（MUST）确保所有文件读写工具在执行 `secureResolve{Read,Write}Path` 时传递 `ToolExecutionContext` 或 `sessionContext`，使会话白名单检查和一次性令牌验证在双端均生效。

#### 场景: checkSafety 识别已有 session grant
- **WHEN** 工具 `checkSafety()` 被调用，且目标资源已存在当前会话的只读或可写白名单中
- **THEN** 系统必须（MUST）在安全审查阶段返回 `status: 'pass'`，跳过审批弹窗

#### 场景: execute 通过 session grant 放行越界路径
- **WHEN** 用户已通过 `always` 审批，资源已写入会话白名单，工具 `execute()` 调用 `secureResolveWritePath(targetPath, sessionContext)`
- **THEN** 系统必须（MUST）在白名单中匹配到对应路径后直接放行执行

#### 场景: execute 通过 call capability 放行
- **WHEN** 用户已通过 `once` 审批，令牌已注册并 claim，工具 `execute()` 调用 `secureResolveWritePath(targetPath, execContext)`
- **THEN** 系统必须（MUST）通过 `execContext.sessionContext.hasClaimedResource(toolCallId, access, normalizedPath)`（`hasClaimedResource` 定义在 `SessionContext` 上；access 参数由 `secureResolveReadPath` 传入 `'read'`，由 `secureResolveWritePath` 传入 `'write'`）检查通过后放行执行，令牌不写入白名单。读授权不得通过写路径检查，反之亦然。

### 需求: GrepSearchTool 路径解析器切换
系统必须（MUST）将 `GrepSearchTool` 的路径安全性检查从 `secureResolvePath`（不支持白名单）切换为 `secureResolveReadPath`（支持会话只读白名单和 ToolExecutionContext）。

#### 场景: Grep 在已授权的越界目录中搜索
- **WHEN** 用户已将会话只读白名单授予某外部目录，`GrepSearchTool` 在该目录下执行搜索
- **THEN** 系统必须（MUST）通过 `secureResolveReadPath` 的白名单检查后允许搜索执行

### 需求: DeletePathTool 审批路径收敛（ADDED）
系统必须（MUST）将 `DeletePathTool` 的审批收敛到统一的 `checkSafety → HumanApprovalPlugin` 路径，移除分散在多层的冗余审批逻辑。

#### 场景: DeletePathTool 走统一审批管线
- **WHEN** `DeletePathTool` 触发安全审查
- **THEN** 系统必须通过 `checkSafety()` 返回包含 `resources` 的挂起结果，由 `HumanApprovalPlugin` 统一处理审批流程
- **THEN** `virtual-mcp.ts` 不得再对 `deletePath` 执行特殊的 `waitApproval` 遮蔽逻辑
- **THEN** `DeletePathTool.execute()` 内部不得再调用 `sessionContext.waitApproval()`，审批决策完全由插件管线驱动

### 需求: Tail call 路径 toolCallId 透传（ADDED）
系统必须（MUST）确保 `agent-loop.ts` 中的 tail call 路径与主调用路径享有同等的 toolCallId 透传与审批生命周期支持。

#### 场景: Tail call 触发审批时走完整管线
- **WHEN** tail call（`agent-loop.ts:693`）触发需要审批的工具调用
- **THEN** 系统必须生成独立的 `toolCallId`，传入 `toolRegistry.callTool()`，走完整的 beforeTool 管线 → pendingGrant 提交 → 令牌生命周期，与主调用路径（`agent-loop.ts:642`）行为一致
