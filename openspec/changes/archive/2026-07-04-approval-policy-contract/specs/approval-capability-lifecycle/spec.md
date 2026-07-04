## 新增需求

### 需求: 持久化规则授权效果（persistent rule effect）
系统必须（MUST）支持 `persistent` 类型的授权效果，用于将命令前缀规则持久化写入磁盘白名单，与 `call`（一次性令牌）和 `session`（会话白名单）并列。

#### 场景: AgentLoop 提交 persistent 效果
- **WHEN** `HumanApprovalPlugin` 返回 `persistent` 类型的授权效果，且 `AgentLoop` 在授权效果提交阶段匹配到该效果
- **THEN** 系统必须通过 `SecurityService.getInstance().saveSecurityAllowlist()` 将命令前缀规则追加到持久化白名单文件
- **THEN** `persistent` 效果仅对 `command-prefix` 资源类型生效，对其他资源类型降级为 `call`

#### 场景: persistent 与 call/session 互斥提交
- **WHEN** 一次审批决策同时满足多个效果（如 `session` + `persistent`）
- **THEN** `ApprovalPolicy.mapChoiceToEffect()` 必须（MUST）只返回单一效果类型，由策略层在 choice 级别做出选择
