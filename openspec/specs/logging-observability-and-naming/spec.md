## 新增需求

### 需求: 关键状态必须可追踪

系统必须在关键状态切换时输出结构化诊断日志，以便排查事件生命周期、自动唤醒和工作模式切换问题。

#### 场景: 生成状态进入与退出
- **WHEN** `session.ts` 开始一次推理生成或结束一次生成时
- **THEN** 系统必须记录当前生成状态的进入、退出与原因信息，且日志必须以结构化属性对象写入。

#### 场景: 自动唤醒链路
- **WHEN** `hasPendingAsyncNotification` 被置位、清除或 `autoWakeupCount` 发生变化时
- **THEN** 系统必须记录对应状态变化，并至少包含 `component`、`event`、`sessionId` 字段；其中状态变化事件可以额外携带 `oldValue`、`newValue`、`reason`、`wakeupCount`。

#### 场景: 工作模式切换
- **WHEN** 用户尝试切换工作模式
- **THEN** 系统必须记录切换结果；如果因 `isProcessing` 被拒绝，也必须记录拒绝原因并保持结构化字段可检索。

#### 场景: Hook 管道处理状态变迁
- **WHEN** `plugin-runner.ts` 进入或退出 hook 管道处理（`isProcessing` 变为 `true` 或 `false`）
- **THEN** 系统必须以 `debug` 级别记录状态变迁，携带 `sessionId` 和触发该管道调用的 `eventName`，以便排查 `isProcessing` 锁阻塞问题。

### 需求: 文件命名必须可读且唯一

系统必须为 `trace`、`audit`、`session` 文件提供可读且唯一的命名方式，便于按会话快速定位文件并避免碰撞。

#### 场景: 同毫秒创建多个会话
- **WHEN** 两个会话在相近时间启动
- **THEN** 两个会话必须生成不同的 `sessionId`，且 `trace`、`audit`、`session` 三类文件必须复用同一个 `sessionId`。

#### 场景: 文件回溯定位
- **WHEN** 开发者查看 `.myagent` 下的历史文件
- **THEN** 文件名必须保留可读时间前缀，便于按会话时间范围筛选，同时不能失去全局唯一性。

### 需求: 运行时关键阶段必须输出可关联的结构化日志

系统必须（MUST）为实际 effect、目录测量和技能热重载输出结构化状态事件，至少包含 component、event、sessionId、correlationId、status 和适用的 durationMs，不得只留下无法关联的自然语言文本。

#### 场景: 目录测量结束
- **WHEN** 受限目录测量完成、截断、失败或取消
- **THEN** 日志必须记录扫描条目、耗时、完整性、错误与跳过计数，不得写入文件正文

#### 场景: watcher 候选事件无内容变化
- **WHEN** watcher 收到候选事件但摘要比较无变化
- **THEN** 最多记录 DEBUG 级候选事件，不得产生误导性的 INFO 变更日志

### 需求: 内部日志不得直接充当用户界面

内部 logger 输出必须（MUST）与 AgentEvent/UI 状态分离。默认交互界面不得展示 `RuleManager`、适配器类名或原始内部命令。

#### 场景: 用户等待显式工具执行
- **WHEN** 用户或 AI 显式运行检查、编译或测试命令
- **THEN** UI 必须通过正常工具调用生命周期展示状态与结果，不得把内部 logger 文本直接当作产品事件

### 需求: trace 必须保持可回放性

系统必须保留 trace 的黑匣子属性，同时减少重复上下文写入。

#### 场景: 生成 trace 头部信息
- **WHEN** 新会话开始写 trace
- **THEN** 系统必须先写入 `meta` 记录，至少包含 `sessionId`、`startTime`、`model` 和 `initialSystemPromptHash`，且 `meta` 只允许出现一次。

#### 场景: 生成 prompt 定义
- **WHEN** 会话首次出现 system prompt 或 system prompt 内容变化
- **THEN** 系统必须写入 `prompt_definition` 记录，记录完整 canonical system messages 与对应 hash。

#### 场景: prompt 内容变化
- **WHEN** 会话中的 system prompt 内容发生变化
- **THEN** 系统必须写入新的完整 prompt 定义，后续 `iteration` 仅引用新的 hash。

#### 场景: prompt 内容未变化
- **WHEN** 会话中的 system prompt 内容没有变化
- **THEN** 系统可以仅引用 hash，避免重复写入相同内容。

#### 场景: 多条 system message
- **WHEN** 当前上下文包含多条 system message
- **THEN** 系统必须先按稳定顺序规范化这些 message，再计算 hash 与写入 prompt 定义，且 `prompt_definition.messages` 必须保持数组顺序。

#### 场景: 非字符串内容
- **WHEN** system content 不是字符串
- **THEN** 系统必须先序列化为可读 JSON 文本，再参与 hash 和落盘。

#### 场景: 原始顺序回放
- **WHEN** iteration 中存在 system message 占位引用
- **THEN** 读取器必须使用 `system_ref` 和 `prompt_definition.messages` 还原 system message 在原始上下文中的位置。

#### 场景: 中途损坏
- **WHEN** trace 文件最后一行写入中断或损坏
- **THEN** 读取器必须忽略最后一条不完整 JSON 行，并继续返回此前可解析记录。

#### 场景: 旧格式兼容
- **WHEN** 读取旧版 trace 文件，且历史行没有 `type`
- **THEN** 读取器必须按 legacy iteration 处理这些记录，并允许缺少 `prompt_definition`。

### 需求: trace 读取器必须可用

系统必须提供 `TraceReader`，用于将 trace 文件解析为可回放的记录流。

#### 场景: 读取 trace
- **WHEN** 调用方传入 trace 文件路径
- **THEN** `TraceReader` 必须返回包含 meta、prompt definition、iteration 和 legacy iteration 的记录集合。

#### 场景: 尾行损坏
- **WHEN** trace 文件最后一行损坏
- **THEN** `TraceReader` 必须忽略损坏尾行并保留此前记录。

#### 场景: 旧格式读取
- **WHEN** trace 文件中没有 `type`
- **THEN** `TraceReader` 必须按 legacy iteration 兼容读取。

#### 场景: 回放顺序
- **WHEN** 调用方根据读取结果进行回放
- **THEN** 读取结果必须能够通过 `system_ref` 还原 system message 的原始位置。

### 需求: 会话快照必须保持恢复语义

系统必须保持 `ContextRepository` 的 JSON 快照语义，不得把会话快照改成追加式 JSONL 日志。

#### 场景: 保存与恢复
- **WHEN** 系统调用 `saveState()` 保存会话
- **THEN** 生成的快照必须仍然可以被 `loadState()` 直接恢复，且默认路径保持兼容。

#### 场景: 新旧文件定位
- **WHEN** 调用方使用会话 ID 进行恢复
- **THEN** 系统必须优先定位新格式文件，并兼容查找旧格式文件；调用方传入的是 session ID，不是完整文件名。

#### 场景: 部分写入失败
- **WHEN** 快照写入被中断或失败
- **THEN** 系统必须优先保证旧快照仍然可用，并清理同目录临时文件。

#### 场景: 并发保存
- **WHEN** 多次 `saveState()` 连续或并发触发
- **THEN** 系统必须通过串行执行避免交叉覆盖，不能产生损坏快照文件。

### 需求: 有效模型配置必须在启动与切换时可追踪

系统必须（MUST）在运行时完成配置加载以及会话模型切换时记录结构化配置事件。事件必须包含 profile ID、实际 provider model、context window、reasoning effort、切换结果和适用的 session ID，且不得包含 API key、认证 header 或其他凭证。

#### 场景: 启动后尚未发送聊天

- **WHEN** 进程完成模型 adapter 和 session 初始化，但用户尚未发送任何聊天消息
- **THEN** `run.log` 必须存在一条可确认有效模型及 context window 的启动配置事件，同时不得为了产生日志而创建伪 session snapshot 或 iteration

#### 场景: 会话模型切换成功

- **WHEN** `/model` 完成一次有效配置切换
- **THEN** 系统必须记录切换前后 profile、实际 provider model、context window 和 reasoning effort，并标记成功

#### 场景: 模型切换失败

- **WHEN** 目标配置校验、adapter 更新或默认配置持久化失败
- **THEN** 系统必须记录失败阶段和最终仍生效的配置，且不得记录密钥或完整认证 header
