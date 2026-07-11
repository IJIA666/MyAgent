## MODIFIED Requirements

### Requirement: 授权作用域检查必须按资源类型和优先级链依次判定

系统必须（MUST）按可信资源类型和当前工作模式判定授权状态。对于确实需要审批的操作，检查链必须依次覆盖 `call capability → session authorization → persistent authorization → 触发审批`；不适用于当前模式或资源类型的作用域应跳过，但系统不得展示一个随后不会被该检查链消费的授权选项。非敏感且已被静态证明为 read 的操作在授权链之前直接放行。

#### Scenario: 可证明只读操作不依赖历史授权

- **WHEN** 当前操作被可信策略判定为非敏感 read
- **THEN** 系统直接放行，不创建伪 capability，也不要求白名单规则为安全结论背书

#### Scenario: call capability 优先于长期作用域

- **WHEN** 当前工具调用存在匹配资源的有效 call capability
- **THEN** 系统必须先 claim 该 capability 并执行，完成后无论成功或失败均消费

#### Scenario: session 授权跨 run 生效

- **WHEN** 用户在当前 SessionManager 中授予某个可信资源 session 权限
- **THEN** 后续 run 中匹配该资源的操作必须自动命中，直到 SessionClosed 清理

#### Scenario: persistent 授权跨会话生效

- **WHEN** 用户对可持久化操作族授予 persistent 权限
- **THEN** 后续会话中匹配同一操作族和参数约束的调用必须自动命中，除非更高优先级策略明确拒绝

#### Scenario: 模式禁止的授权不进入选择列表

- **WHEN** 当前模式禁止消费某种长期授权
- **THEN** ApprovalPolicy 不得展示该授权选项；系统不得先接受用户选择再在后续调用中忽略
