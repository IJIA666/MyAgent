## 新增需求

### 需求: 生命周期边界与授权边界必须显式区分

系统必须（MUST）将生命周期边界与授权边界显式区分，避免把 `run`、`session`、`persistent` 混成同一类临时状态。当前实现中，真正存在且可执行的授权机制为 `call`、`session`、`persistent` 三类；`run` 仅作为执行生命周期边界存在，不在本次变更中引入独立授权容器。

边界定义：
- **call**：仅当前工具调用有效，通过 `CallCapability` 令牌（registered → claimed → removed）承载，执行完成后自动失效。
- **run**：仅当前一次 `AgentLoop.chat()` 调用有效，作为引擎内部生命周期边界存在，不暴露为面向用户的审批选项，也不要求新增白名单容器。
- **session**：当前 `SessionManager` 实例生命周期有效，由用户选择"会话始终放行"后写入，会话关闭时通过 `SessionClosed` 触发清理。
- **persistent**：落盘持久化，通过 `SecurityService.saveSecurityAllowlist()` 写入磁盘，跨会话和进程重启有效。

#### 场景: call 作用域令牌生命周期独立于其他作用域
- **WHEN** 用户选择"单次放行"，系统注册 `CallCapability` 令牌
- **THEN** 令牌仅对当前 `toolCallId` 有效，执行后无论成功或失败均被 consume
- **AND** 令牌的注册/claim/consume 机制不受 run 结束或 session 关闭影响

#### 场景: run 仅作为生命周期边界存在
- **WHEN** 单次 `AgentLoop.chat()` 结束，触发 `RunEnd`
- **THEN** 系统只处理 run 级生命周期收尾
- **AND** 不得因为存在 `RunEnd` 就推导出额外的 run 级授权白名单

#### 场景: session 作用域白名单跨多次 run 保持有效
- **GIVEN** 用户在某次 `chat/run` 中对路径 `/projects/foo` 选择了"会话始终放行"（session 授权）
- **WHEN** 同一个 `SessionManager` 实例中，后续任意次 `chat/run` 再次操作 `/projects/foo`
- **THEN** session 白名单中的授权必须持续生效，不得因单次 run 结束而被清空

#### 场景: session 作用域白名单在会话关闭时清理
- **WHEN** `SessionManager.close()` 被调用，进入 `SessionClosed` 阶段
- **THEN** 系统必须调用 `clearTemporaryWhitelists(sessionId)`，清除该会话的所有读/写/目录范围临时白名单
- **AND** 持久化白名单（persistent）不受影响

#### 场景: persistent 作用域跨会话持久有效
- **GIVEN** 用户在某次会话中对某命令前缀选择了"永久放行"
- **WHEN** 当前会话关闭，新会话启动
- **THEN** 该命令前缀的持久化授权规则仍然存在于磁盘白名单中，新会话的审批检查自动通过

### 需求: 授权作用域检查必须按资源类型和优先级链依次判定

系统必须（MUST）按可信资源类型和当前工作模式判定授权状态。对于确实需要审批的操作，检查链必须依次覆盖 `call capability → session authorization → persistent authorization → 触发审批`；不适用于当前模式或资源类型的作用域应跳过，但系统不得展示一个随后不会被该检查链消费的授权选项。非敏感且已被静态证明为 read 的操作在授权链之前直接放行。

#### 场景: 可证明只读操作不依赖历史授权

- **WHEN** 当前操作被可信策略判定为非敏感 read
- **THEN** 系统直接放行，不创建伪 capability，也不要求白名单规则为安全结论背书

#### 场景: call capability 优先于长期作用域

- **WHEN** 当前工具调用存在匹配资源的有效 call capability
- **THEN** 系统必须先 claim 该 capability 并执行，完成后无论成功或失败均消费

#### 场景: session 授权跨 run 生效

- **WHEN** 用户在当前 SessionManager 中授予某个可信资源 session 权限
- **THEN** 后续 run 中匹配该资源的操作必须自动命中，直到 SessionClosed 清理

#### 场景: persistent 授权跨会话生效

- **WHEN** 用户对可持久化操作族授予 persistent 权限
- **THEN** 后续会话中匹配同一操作族和参数约束的调用必须自动命中，除非更高优先级策略明确拒绝

#### 场景: 模式禁止的授权不进入选择列表

- **WHEN** 当前模式禁止消费某种长期授权
- **THEN** ApprovalPolicy 不得展示该授权选项；系统不得先接受用户选择再在后续调用中忽略

### 需求: 临时白名单清理必须且仅在 SessionClosed 触发点执行

系统必须（MUST）确保 `clearTemporaryWhitelists()` 仅由 `SessionManager.close()` 在 `SessionClosed` 阶段触发，任何其他位置（包括 `AgentLoop.chat()` 的 `finally` 块、`RunEnd` Hook 管道等）均不得调用该方法。

#### 场景: AgentLoop.finally 不再清空白名单
- **WHEN** `AgentLoop.chat()` 的 while 循环完成一次迭代，进入内部 finally 收尾
- **THEN** 系统不得调用 `clearTemporaryWhitelists()`
- **AND** session 白名单中的授权保持有效，供后续迭代或后续 `chat/run` 调用使用

#### 场景: 并发 chat/run 之间的白名单共享
- **GIVEN** 同一个 `SessionManager` 实例依次执行两次 `chat/run` 调用
- **AND** 第一次 `chat/run` 中用户授予了若干 session 级授权
- **WHEN** 第二次 `chat/run` 开始执行
- **THEN** 第一次 `chat/run` 写入的 session 白名单仍然存在且有效
