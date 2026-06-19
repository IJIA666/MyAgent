## 修改需求

### 需求: 人机交互决策反馈闭环
系统必须（MUST）提供外部 UI/客户端回复审批决策的入口，并能根据反馈执行放行、单次拒绝、持久化始终放行以及联动级联安全熔断。

#### 场景: 用户明确拒绝
- **WHEN** 外部接收到挂起事件并在 UI 处理完毕后，调用 `ApprovalService.resolve` 且动作为 `deny` 时
- **THEN** 系统应唤醒挂起的执行流，自动向大模型注入“调用被插件拦截：User denied” 的工具执行报错信息，且终端决不会发生任何物理动作。

#### 场景: 用户同意并持久化白名单
- **WHEN** 外部调用 `ApprovalService.resolve` 且动作为 `always` 时
- **THEN** 系统应记录并持久化该模式至白名单，继续唤醒并执行该工具；下次遇到相同模式时不需再次弹出。

#### 场景: 会话级挂起队列的级联安全熔断
- **WHEN** 某一会话中有多个高危工具调用并发或串行挂起等待审批，且用户对其中某一个挂起请求显式驳回（resolve 动作为 deny）时
- **THEN** 系统必须（MUST）在唤醒退出当前被拒请求的同时，自动将当前会话下在挂起列表（`pendingRequests`）中等待的所有其他请求一并标记为“已中止”，彻底清除会话残留队列。
- **THEN** 系统必须向其余所有被中止的工具调用统一返回包含“中断重塑”上下文的安全阻断报错（如 `HaltedByReject: Operation rejected by user, and all subsequent pending actions have been cancelled.`），允许大模型在此基础上重新执行中断重塑（Halt & Re-plan）。
- **THEN** 此级联熔断动作只局限在被拒绝会话内部，对其他不同 `sessionID` 的并发会话挂起队列绝不产生任何影响。
