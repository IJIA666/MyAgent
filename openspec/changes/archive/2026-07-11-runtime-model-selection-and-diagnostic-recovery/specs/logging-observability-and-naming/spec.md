## ADDED Requirements

### Requirement: 有效模型配置必须在启动与切换时可追踪

系统必须（MUST）在运行时完成配置加载以及会话模型切换时记录结构化配置事件。事件必须包含 profile ID、实际 provider model、context window、reasoning effort、切换结果和适用的 session ID，且不得包含 API key、认证 header 或其他凭证。

#### Scenario: 启动后尚未发送聊天

- **WHEN** 进程完成模型 adapter 和 session 初始化，但用户尚未发送任何聊天消息
- **THEN** `run.log` 必须存在一条可确认有效模型及 context window 的启动配置事件，同时不得为了产生日志而创建伪 session snapshot 或 iteration

#### Scenario: 会话模型切换成功

- **WHEN** `/model` 完成一次有效配置切换
- **THEN** 系统必须记录切换前后 profile、实际 provider model、context window 和 reasoning effort，并标记成功

#### Scenario: 模型切换失败

- **WHEN** 目标配置校验、adapter 更新或默认配置持久化失败
- **THEN** 系统必须记录失败阶段和最终仍生效的配置，且不得记录密钥或完整认证 header
