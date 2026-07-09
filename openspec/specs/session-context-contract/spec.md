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

`SessionContext` 拆分后，`CallCapability` 的 `registered → claimed → removed` 三状态生命周期必须保持不变。

#### 场景: 注册令牌后状态为 registered

- **WHEN** 调用 `registerCallCapability(cap)` 注册令牌
- **THEN** 令牌状态为 `'registered'`，`createdAt` 被自动填充

#### 场景: 三重校验通过的 claim 操作

- **WHEN** 调用 `claimCapability(toolCallId, toolName, args)` 且 toolCallId、toolName、argumentsDigest 三重匹配均通过
- **THEN** 令牌状态切换为 `'claimed'`，返回绑定的资源列表

#### 场景: 摘要不匹配时 claim 操作被拒绝

- **WHEN** 调用 `claimCapability(toolCallId, toolName, args)` 但 `argumentsDigest` 与注册时不一致
- **THEN** 返回 `null`，令牌状态保持 `'registered'`

### 需求: 审批结果映射契约保持

`SessionContext` 拆分后，`waitApproval()` 对 `ApprovalService` 决策结果的映射语义必须保持不变。

#### 场景: 授权型决策映射为 approve

- **WHEN** `ApprovalService.wait(...)` 返回的 `action` 为 `'call'`、`'session'` 或 `'persistent'`
- **THEN** `waitApproval()` 返回 `{ action: 'approve' }`

#### 场景: 拒绝型决策映射为 deny

- **WHEN** `ApprovalService.wait(...)` 返回的 `action` 不属于 `'call'`、`'session'`、`'persistent'`
- **THEN** `waitApproval()` 返回 `{ action: 'deny' }`

### 需求: 临时白名单访问契约保持

`SessionContext` 拆分后，临时读写白名单的查询与写入语义必须保持不变。

#### 场景: 加入临时只读白名单后可被查询命中

- **WHEN** 调用 `addTemporaryReadWhitelist(path)` 后，再调用 `hasTemporaryReadWhitelist(path)`
- **THEN** 返回 `true`

#### 场景: 清空临时白名单后查询失效

- **WHEN** 已存在临时读或写白名单记录时调用 `clearTemporaryWhitelists()`
- **THEN** 后续对同一路径调用 `hasTemporaryReadWhitelist(path)` 或 `hasTemporaryWriteWhitelist(path)` 均返回 `false`

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

`SessionContext` 拆分后，当前依赖 `isProcessing` 的公开写接口仍必须保持原有阻断语义。

#### 场景: 忙状态下修改工作模式被拒绝

- **WHEN** `isProcessing === true` 时调用 `setWorkMode(mode)`
- **THEN** 调用抛出错误，且工作模式保持原值不变
