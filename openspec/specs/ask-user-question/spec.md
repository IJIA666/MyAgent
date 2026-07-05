## 修改需求

### 需求: ask-structured-question

系统必须(SHALL)支持向用户提出包含结构化选项的提问，每个选项包含显示标签(label)与可选描述说明(description)，取代纯字符串选项。

#### 场景: 模型调用带结构化选项的 ask_user_question

- **WHEN** 模型调用 `ask_user_question` 并传入包含 `options` 参数，每个选项包含 `label` 和 `description` 字段
- **THEN** 系统必须(SHALL)在 CLI 中将 `label` 作为选项显示文本，`description` 作为选项附带说明展示

#### 场景: 选项数量校验

- **WHEN** 模型传入的 `options` 数量小于 2 或大于 4
- **THEN** 系统必须(MUST)拒绝该调用并返回校验错误

### 需求: ask-question-mode

系统必须(SHALL)支持显式的提问模式枚举，以 `mode` 字段声明问题的交互方式，取代 `multiSelect` + `allowFreeInput` 的布尔组合。

#### 场景: single-select 模式

- **WHEN** 模型设置 `mode: "single-select"` 且附带结构化选项
- **THEN** 系统必须(SHALL)在 CLI 中使用单选交互，展示选项的 `label` 作为主文本，`description` 作为辅助说明
- **THEN** 用户确认后，系统必须(SHALL)以该问题的 `id -> string` 结构返回答案

#### 场景: multi-select 模式

- **WHEN** 模型设置 `mode: "multi-select"`
- **THEN** 系统必须(SHALL)在 CLI 中使用多选交互，返回 `string[]`
- **THEN** 系统必须(SHALL)保持多选答案的结构，不得再折叠为约定分隔符拼接的单一字符串

#### 场景: free-text 模式

- **WHEN** 模型设置 `mode: "free-text"`
- **THEN** 系统必须(SHALL)在 CLI 中使用纯文本输入，不提供预设选项

#### 场景: single-select-or-text 模式

- **WHEN** 模型设置 `mode: "single-select-or-text"`
- **THEN** 系统必须(SHALL)在 CLI 中使用单选 + Other 自由输入混合模式
- **THEN** 用户选中 Other 后，系统必须(SHALL)切换为文本输入模式采集自定义内容

### 需求: ask-multiple-questions

系统必须(SHALL)支持单次 `ask_user_question` 调用中包含多个独立问题。

#### 场景: 多问题批量提交

- **WHEN** 模型调用 `ask_user_question` 并传入 `questions` 数组，长度 1-4
- **THEN** 系统必须(SHALL)在 CLI 中依次渲染每个问题，按各自的 `mode` 使用对应交互组件
- **THEN** 系统必须(SHALL)在所有问题回答完毕后返回按 `id` 索引的答案映射

#### 场景: 问题数量校验

- **WHEN** 模型传入的 `questions` 数组长度小于 1 或大于 4
- **THEN** 系统必须(MUST)拒绝该调用并返回校验错误

#### 场景: 非法问题载荷被拒绝

- **WHEN** agent 传入缺失必填字段的问题，或为选择题省略 `options`
- **THEN** 系统必须(MUST)拒绝该次工具调用并返回参数校验错误

### 需求: ask-cli-dedup

系统必须(MUST)防止同一挂起提问的 UI 被重复拉起。

#### 场景: interaction_request 防重

- **WHEN** CLI 已经为某个 `interactionId` 拉起 ask 交互界面
- **THEN** 后续针对同一 `interactionId` 的重复 `interaction_request` 必须(MUST)被忽略
- **THEN** 重复的 `/resume` 输入也必须(MUST)被忽略，不得创建第二个 ask 交互界面

#### 场景: 快照恢复仅重放仍处于 pending 的提问

- **WHEN** 系统从快照恢复 ask 交互
- **THEN** 只有仍处于 `pending` 状态的交互可能(MAY)被恢复
- **THEN** 已回答或已取消的交互必须(MUST NOT)被重新拉起

### 需求: ask-snapshot-replay

系统必须(SHALL)在从快照恢复 PendingInteraction 时校验载荷格式。

#### 场景: 快照恢复新版 questions 载荷

- **WHEN** 系统从快照恢复 `pendingInteraction` 且载荷为 `questions[]` 格式
- **THEN** 系统必须(SHALL)通过规范化校验后恢复交互

#### 场景: 快照丢弃旧版 title/options 载荷

- **WHEN** 系统从快照恢复 `pendingInteraction` 且载荷为旧版 `title/options` 格式
- **THEN** 系统必须(SHALL)安全丢弃该快照，不恢复、不迁移

### 需求: ask-InteractionPort-contract

系统必须(MUST)提供 `InteractionPort` 接口，作为工具层发起 ask 交互的挂起等待通道，并以结构化答案恢复工具执行。

#### 场景: askUser 方法契约

- **WHEN** 工具调用 `InteractionPort.askUser(payload)`
- **THEN** 系统必须(MUST)挂起当前工具执行，将 `questions` 载荷传递给 CLI 层渲染交互界面
- **THEN** 用户完成回答后，系统必须(MUST)返回按问题 `id` 组织的结构化答案映射

#### 场景: 用户取消或外部中断

- **WHEN** 用户取消提问，或外部 `AbortSignal` 中断等待
- **THEN** `InteractionPort.askUser()` 必须(MUST)返回空答案对象
- **THEN** CLI 层必须(MUST)清理 ask 交互界面并恢复全局输入监听
