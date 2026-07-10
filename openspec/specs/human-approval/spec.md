## 新增需求

### 需求: 高危操作静默拦截与事件抛出
系统必须（MUST）对预设的高风险指令（如 `rm -rf`）进行语义层面的嗅探，当命中风险阈值且不在白名单内时，必须主动拦截工具调用，并通过 AgentEvent 体系抛出挂起信号，同时不阻塞底层 Node.js 事件循环。

#### 场景: 拦截首次未授权的毁灭性命令
- **WHEN** 智能体试图调用 `run_terminal_command` 执行包含 `rm -rf` 等敏感模式的命令，且该命令并未记录在白名单时
- **THEN** 系统应立刻阻断底层物理执行器，向外层抛出包含 `type: 'suspend'` 的 `AgentEvent`，并利用 `ApprovalService` 将当前中间件上下文原生挂起。

#### 场景: 超时全局生命周期阻断拦截与 AbortController 底层穿透
- **WHEN** 智能体工具执行的总时长超过了系统所设置的预设超时时阈（如 30 秒）时
- **THEN** 系统调度必须 (MUST) 触发注入的 `AbortController` 并在底层文件操作（如 `fs.promises.readFile`）、外部脚本子进程（如 `exec`）以及 MCP 通信信道中深度传递 and 物理响应此 Abort 信号以彻底阻断拦截，强杀挂起中的异步进程，释放 Node.js 的事件循环占用，并向智能体回传超时报错。

### 需求: 人机交互决策反馈闭环
系统必须（MUST）提供外部 UI/客户端回复审批决策的入口，并能根据反馈执行放行、单次拒绝、持久化始终放行以及联动级联安全熔断。审批 choice 集由 `ApprovalPolicy` 中央策略层根据操作类型、WorkMode 和资源类型动态生成，UI 层不再自行推导。

#### 场景: 用户明确拒绝
- **WHEN** 外部接收到挂起事件并在 UI 处理完毕后，调用 `ApprovalService.resolve` 且动作为 `deny` 时
- **THEN** 系统应唤醒挂起的执行流，自动向大模型注入"调用被插件拦截：User denied"的工具执行报错信息，且终端决不会发生任何物理动作。

#### 场景: 用户选择始终放行（MODIFIED）
- **WHEN** 外部调用 `ApprovalService.resolve` 且动作为 `session`
- **THEN** 系统必须在 `HumanApprovalPlugin.beforeToolMiddleware` 中调用 `ApprovalPolicy.mapChoiceToEffect('session', operation, toolName)`，生成 `session` 类型的 `PendingGrant`（按 access 分类路径资源），在 `agent-loop` 条件满足时写入会话临时白名单。

#### 场景: 用户选择持久化放行（ADDED）
- **WHEN** 外部调用 `ApprovalService.resolve` 且动作为 `persistent`，且操作涉及命令前缀资源
- **THEN** 系统必须调用 `ApprovalPolicy.mapChoiceToEffect('persistent', operation, toolName)`，生成持久化规则效果，由 `AgentLoop` 在条件满足时通过 `SecurityService` 写入磁盘白名单。
- **THEN** 若操作不涉及命令前缀，persistent 降级为 `call`。

#### 场景: 用户选择单次放行（MODIFIED）
- **WHEN** 外部调用 `ApprovalService.resolve` 且动作为 `call`
- **THEN** 系统必须在 `HumanApprovalPlugin.beforeToolMiddleware` 中调用 `ApprovalPolicy.mapChoiceToEffect('call', operation, toolName)`，生成 `call` 类型的 `PendingGrant`（绑定 `toolCallId`、工具名和资源列表），在 `agent-loop` 条件满足时通过 `registerCallCapability` 注册一次性令牌。
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

### 需求: DeletePathTool 审批路径收敛
系统必须（MUST）将 `DeletePathTool` 的审批收敛到统一的 `checkSafety → HumanApprovalPlugin` 路径，移除分散在多层的冗余审批逻辑。

#### 场景: DeletePathTool 走统一审批管线
- **WHEN** `DeletePathTool` 触发安全审查
- **THEN** 系统必须通过 `checkSafety()` 返回包含 `resources` 的挂起结果，由 `HumanApprovalPlugin` 统一处理审批流程
- **THEN** `virtual-mcp.ts` 不得再对 `deletePath` 执行特殊的 `waitApproval` 遮蔽逻辑
- **THEN** `DeletePathTool.execute()` 内部不得再调用 `sessionContext.waitApproval()`，审批决策完全由插件管线驱动

### 需求: Tail call 路径 toolCallId 透传
系统必须（MUST）确保 `agent-loop.ts` 中的 tail call 路径与主调用路径享有同等的 toolCallId 透传与审批生命周期支持。

#### 场景: Tail call 触发审批时走完整管线
- **WHEN** tail call 触发需要审批的工具调用
- **THEN** 系统必须生成独立的 `toolCallId`，传入 `toolRegistry.callTool()`，走完整的 beforeTool 管线 → pendingGrant 提交 → 令牌生命周期，与主调用路径行为一致

### 需求: HumanApprovalPlugin 委托 ApprovalPolicy（ADDED）
`HumanApprovalPlugin` 的审批决策映射逻辑必须（MUST）委托 `ApprovalPolicy` 中央策略服务，不再自行硬编码 `once/always → call/session` 映射。

#### 场景: 委托策略层生成 choice 列表
- **WHEN** `HumanApprovalPlugin.beforeToolMiddleware` 收到 `suspend` 状态且工具已返回 `SafetyOperation`
- **THEN** 插件必须调用 `ApprovalPolicy.resolve({ toolName, toolArgs, operation, workMode })`，获取 `ApprovalRequest`（含 choices + 校验后的资源），将 `choices` 随 `suspend` 事件广播给 UI 层

#### 场景: 降级处理缺失的 SafetyOperation
- **WHEN** 工具的 `checkSafety()` 返回 `suspend` 但未附带 `SafetyOperation`（旧格式）
- **THEN** `HumanApprovalPlugin` 必须从 `safetyResult.resources`、`safetyResult.targetPath`、`safetyResult.message` 和工具的 `securityCategory` 组装降级 `SafetyOperation`，再委托 `ApprovalPolicy`

#### 场景: 委托策略层映射授权效果
- **WHEN** UI 返回 `choiceId` 后
- **THEN** `HumanApprovalPlugin` 必须调用 `ApprovalPolicy.mapChoiceToEffect(choiceId, operation, toolName)` 获取授权效果
- **THEN** 根据效果类型构造 `context.pendingGrant` 或 `context.persistentRuleEffect`，不再自行判断 `decision.action`

### 需求: UI 层从 ApprovalRequest 渲染选项
UI 层（`facade.ts`）必须（MUST）从 `ApprovalRequest.choices` 渲染审批选项，不再硬编码 `once/always/deny` 列表。

#### 场景: 渲染策略层下发的 choices
- **WHEN** UI 收到 `suspend` 事件，且事件中携带 `choices: ApprovalChoice[]`
- **THEN** UI 必须遍历 `choices` 数组，为每个 `ApprovalChoice` 渲染对应的选项按钮，使用 `label` 和 `description` 作为展示文本
- **THEN** 用户选择后，UI 仅返回 `choiceId`，不执行任何授权操作

#### 场景: 降级处理无 choices 的旧 suspend 事件
- **WHEN** UI 收到 `suspend` 事件，但事件中不包含 `choices` 字段（旧格式）
- **THEN** UI 必须继续使用现有的 `allowedPrefix` 推导逻辑作为降级行为

### 需求: HumanApprovalPlugin 必须消费显式工具策略端口

`HumanApprovalPlugin` 必须从 `ToolPolicyPort` 获取安全判定，不得从 `ToolRegistryPort.getTool()` 的返回值探测或调用 `checkSafety()`。

#### 场景: 安全工具直接放行

- **WHEN** ToolPolicyPort 返回 `status: 'pass'`
- **THEN** HumanApprovalPlugin 必须继续执行后续 BeforeTool 中间件
- **THEN** 不得创建 suspend 事件或 pendingGrant

#### 场景: 策略明确拒绝

- **WHEN** ToolPolicyPort 返回 `status: 'deny'`
- **THEN** HumanApprovalPlugin 必须把控制状态设置为 abort，并使用策略消息说明原因
- **THEN** 不得进入用户审批流程

#### 场景: 策略要求用户审批

- **WHEN** ToolPolicyPort 返回 `status: 'suspend'`
- **THEN** HumanApprovalPlugin 必须继续复用现有 SafetyOperation、ApprovalPolicy、ApprovalService 和授权效果映射流程
- **THEN** 用户可见的 choices 必须由 ApprovalPolicy 生成，插件不得自行扩大授权范围

#### 场景: 单元测试替换策略实现

- **WHEN** 测试构造 HumanApprovalPlugin
- **THEN** 测试可以注入只实现公开 evaluate 契约的 ToolPolicyPort
- **THEN** 测试不得通过 `as unknown as` 为 ToolRegistryPort.getTool() 伪造 checkSafety 方法

### 需求: 策略来源重构不得改变授权生命周期

从工具对象探测迁移到策略端口后，现有授权效果和能力令牌时序必须保持不变。

#### 场景: 用户选择单次放行

- **WHEN** 用户对 suspend 请求选择 call
- **THEN** ApprovalEffectApplier 必须在实际执行前注册一次性能力
- **THEN** 内建工具执行边界必须在执行前领取该能力
- **THEN** 编排器必须在成功、失败或中止后的 finally 中消费该能力

#### 场景: 用户审批外部 MCP 工具

- **WHEN** 无可信资源提取器的外部 MCP 工具进入 suspend 流程
- **THEN** ApprovalPolicy 必须只提供 call 和 deny
- **THEN** 空 resources 的 call capability 只表示本次精确调用获批，并必须在远端执行前按调用 ID、工具名和参数摘要领取
- **THEN** 领取失败时不得调用远端工具，也不得授予任何路径访问范围

#### 场景: tail call 进入审批管线

- **WHEN** AfterTool 产生一个 tail call
- **THEN** tail call 必须使用独立 toolCallId 重新经过 BeforeTool 和 ToolPolicyPort 评估
- **THEN** 不得复用主调用的策略结果或能力令牌
