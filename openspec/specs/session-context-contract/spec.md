## 需求

### 需求: 会话消息历史操作契约保持

`SessionContext` 拆分后，所有公开的消息历史操作方法签名与语义必须保持不变。

#### 场景: 追加消息后历史长度递增

- **WHEN** 调用 `addMessage(message)` 追加一条新消息
- **THEN** `getHistory()` 返回的数组长度必须增加 1，且末尾元素严格等于传入的 `message`

#### 场景: 弹出消息后历史长度递减

- **WHEN** 调用 `popMessage()` 弹出末尾消息
- **THEN** 返回被移除的消息，且 `getHistory()` 数组长度减少 1

#### 场景: 截断历史保留 system prompt

- **WHEN** 调用 `truncateHistory(keepLastN)`
- **THEN** `getHistory()[0]`（system prompt）保持不变，后续仅保留最近 `keepLastN` 条消息

### 需求: 人机中断生命周期契约保持

`SessionContext` 拆分后，`PendingInteraction` 的状态转换规则必须保持不变。

#### 场景: 创建中断后状态为 pending

- **WHEN** 调用 `setPendingInteraction(interaction)` 创建人机中断
- **THEN** 返回的 `PendingInteraction` 状态为 `'pending'`，且再次调用时抛出错误

#### 场景: 回答后状态切换为 answered

- **WHEN** 调用 `answerPendingInteraction(answer)` 回答活跃中断
- **THEN** 中断状态切换为 `'answered'`，`answer` 字段被正确填充

#### 场景: 取消后状态切换为 canceled

- **WHEN** 调用 `cancelPendingInteraction()` 取消活跃中断
- **THEN** 中断状态切换为 `'canceled'`

### 需求: Call Capability 令牌状态机契约保持

> ❌ 已删除 — SessionContext 不再保存旧 capability 状态。授权复用由 `PermissionUpdate` 和规则来源替代，已在 `claude-permission-model` 变更中移除。

**Migration:** 保存 Claude 风格的 `PermissionMode`、`prePlanMode`、规则来源状态和模式转换上下文。

### 需求: 审批结果映射契约保持

> ❌ 已删除 — 旧 `waitApproval()` 映射语义已移除，审批交互由统一权限服务的 `ask` 决策和 `PermissionUpdate` 替代。

### 需求: 临时白名单访问契约保持

> ❌ 已删除 — 临时读写白名单已被 `PermissionRule` 规则来源（`session` 来源）替代。

### 需求: 插件补丁记录语义保持

`SessionContext` 拆分后，插件补丁的追加与提取语义必须保持不变。

#### 场景: 追加补丁后提取并清空

- **WHEN** 先调用 `addPluginPatches(eventName, patches)` 追加补丁，再调用 `getAndClearPluginPatches()`
- **THEN** 返回包含所追加补丁的数组，且内部记录被清空（再次调用返回空数组）

### 需求: 忙锁通知缓冲语义保持

`SessionContext` 拆分后，`isProcessing` 忙锁期间的通知缓冲与刷新语义必须保持不变。

#### 场景: 忙状态期间通知被缓冲

- **WHEN** `isProcessing === true` 时调用 `addNotification(message)`
- **THEN** 消息暂存于缓冲区，`getHistory()` 不增加该条消息

#### 场景: 刷新后缓冲写入历史

- **WHEN** 调用 `flushPendingNotifications()` 刷新缓冲区
- **THEN** 缓冲区内所有消息按序追加到消息历史末尾，缓冲区清空

### 需求: 忙锁下的公开写接口保护契约保持

> ❌ 已删除 — 旧 `setWorkMode` 已由 `PermissionMode` 统一模式管理器替代。忙锁期间的模式修改保护由新管理器保证。

### 需求: Permission Mode Session State

SessionContext MUST 保存当前会话的 `PermissionMode`、可选 `prePlanMode` 和规则更新状态，并保证它们不会被其他会话共享。

#### 场景: Plan entry preserves the prior mode

- **WHEN** 会话从任意非 `plan` 模式进入 `plan`
- **THEN** SessionContext MUST 保存进入前的模式

#### 场景: Plan exit restores the preserved mode

- **WHEN** 会话退出 `plan`
- **THEN** SessionContext MUST 恢复保存的模式并清理已消费的 Plan 状态
