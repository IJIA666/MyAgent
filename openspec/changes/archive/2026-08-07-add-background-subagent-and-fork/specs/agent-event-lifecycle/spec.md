## ADDED Requirements

### Requirement: 任务状态事件不得终结主生成生命周期

系统 SHALL 将 `task_update` 视为非终结性状态事件。该事件 MUST NOT 替代、提前触发或重复主 Agent 当前生成周期的 `complete`。

#### Scenario: 主循环忙碌时收到任务状态

- **WHEN** 主 Agent 正在生成且后台子代理状态发生变化
- **THEN** CLI 可以非阻塞显示任务状态
- **AND** 不恢复 InputListener、不结束当前渲染周期且不发出额外 `complete`

#### Scenario: 后台任务完成触发后续生成

- **WHEN** 后台完成通知在当前生成结束后通过 `async_event` 触发自动唤醒
- **THEN** 被唤醒的新生成拥有自己唯一的 `complete` 终结事件
- **AND** 前一生成周期的 `complete` 次数与顺序保持不变

#### Scenario: 状态事件内容最小化

- **WHEN** `task_update` 被发送给任一 UI 适配器
- **THEN** 事件只包含任务身份、description、策略、状态和时间字段
- **AND** 不包含 prompt、模型输出、工具参数或异常对象
