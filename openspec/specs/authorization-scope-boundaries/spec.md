## Purpose

定义一次调用、一次 Agent run、当前会话和持久配置之间的权限作用域边界。该规范确保执行凭证、会话状态与持久规则各自只有一个所有者，任何较短生命周期都不能隐式扩展为更长生命周期授权。

## Requirements

### Requirement: Execution and Permission Scopes Are Distinct

系统 MUST 明确区分一次调用、run 生命周期、session 权限状态和持久设置，并使用与作用域匹配的机制承载：

- 一次调用只使用服务签发、绑定不可变 ExecutionPlan 的单次 execution grant。
- run 只作为 `AgentLoop.chat()` 的生命周期边界，不形成用户可选授权容器。
- session 权限由当前 `PermissionSessionState` 的 mode、rules 和 additional directories 承载。
- persistent 权限只通过受约束的 settings source 与原子 CAS 写入落盘。

#### Scenario: Allow once remains single-use

- **WHEN** 用户为当前工具调用选择 Allow once
- **THEN** 系统 MUST 只为该 ExecutionPlan 签发一次性 grant
- **THEN** grant 在成功、失败或首次消费后均不得被其他调用复用

#### Scenario: Run end does not clear session authority

- **WHEN** 一次 `AgentLoop.chat()` 结束但当前 SessionContext 仍然存活
- **THEN** 系统 MUST 只完成 run 生命周期收尾
- **THEN** 当前 PermissionSessionState 中有效的 session rules 和 additional directories 保持不变

#### Scenario: A new session loads only persistent sources

- **WHEN** 当前会话关闭后创建新 SessionContext
- **THEN** 新会话 MUST 创建独立 PermissionSessionState
- **THEN** 新会话只能加载 managed、user、project 和 projectLocal 等持久来源，不得恢复旧会话 mode 或临时目录

### Requirement: Authorization Uses One Fixed Priority Pipeline

所有工具调用 MUST 依次经过宿主上限与受保护资源、显式 deny/ask/allow 规则、当前模式、工具候选结果和最终审批动作。任一较高层 deny 或 ask MUST NOT 被较低层 allow、历史 grant 或静态工具类别覆盖。

#### Scenario: A proven safe read needs no historical grant

- **WHEN** 可信工具适配器和宿主策略共同证明当前调用是非敏感 read
- **THEN** 统一权限服务 MAY 直接放行
- **THEN** 系统 MUST NOT 创建伪造的会话规则或长期授权为该结论背书

#### Scenario: An approval action commits before execution

- **WHEN** 最终决策为 ask 且用户选择一个受信 ApprovalAction
- **THEN** 系统 MUST 先原子提交该动作要求的 session 或 persistent updates
- **THEN** 只有完整提交成功后才能签发 ExecutionPlan grant 并开始执行

#### Scenario: A higher-priority restriction wins

- **WHEN** managed host policy 或受保护资源策略拒绝某个调用
- **THEN** session mode、additional directory、普通 allow rule 和审批历史 MUST NOT 覆盖该拒绝

### Requirement: Session Closure Invalidates Session-Owned Authority

SessionContext 关闭时 MUST 销毁其 PermissionSessionState 和尚未消费的 session-bound grants。系统 MUST NOT 维护第二套 temporary read/write whitelist 或通过 run-end hook 清理权限状态。

#### Scenario: Closing one session does not affect another

- **WHEN** 两个会话拥有不同 rules、mode 和 additional directories，随后关闭其中一个
- **THEN** 被关闭会话的未消费 grant MUST 失效
- **THEN** 另一个会话的状态 MUST 保持不变

#### Scenario: Run cleanup has no permission side channel

- **WHEN** run-end hook 或 AgentLoop 的 `finally` 执行
- **THEN** 它们 MUST NOT 创建、提升、复制或清空 session 权限
- **THEN** 权限状态变更只能通过 PermissionSessionState 的受约束更新入口完成
