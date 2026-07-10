## MODIFIED Requirements

### Requirement: Tool Access Port Isolation

外部具体工具适配器（如 `terminal.ts` 或 `file-system.ts`）在运行时绝不允许直接访问或操作核心的 `SessionContext` 实体；工具对核心的交互应当（SHALL）被严格隔离在超薄的、职责单一的 driven ports 中，以防范敏感状态泄露。

#### Scenario: Async System Notification Dispatch

- **WHEN** 外部工具的异步后台进程产生退出、卡死或特征行匹配通知时
- **THEN** 工具应当（SHALL）仅通过 `EventNotificationPort` 接口向会话推送 notification，由核心执行自唤醒，保持依赖清洁。

#### Scenario: Synchronous Tool Result Does Not Dispatch Notification

- **WHEN** 外部工具以同步模式完成并已经通过当前 tool result 返回执行结果
- **THEN** 工具不得额外通过 `EventNotificationPort` 注入完成通知，以避免同一个工具调用同时产生 tool response 和异步 user notification。
