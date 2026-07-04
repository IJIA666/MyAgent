# ask-user-question

## Purpose

提供 agent 向用户发起结构化提问的能力。该能力属于人机协作中的中断式交互：工具声明 `executionMode: 'human_interruption'`，系统创建待回答的 `pendingInteraction` 后暂停当前 run，用户回答后从同一 run 恢复执行。通过 `InteractionPort` 端口契约实现工具层与 CLI 交互层的解耦，与 `ApprovalPort` 在职责上严格分离。

## Requirements

### Requirement: 人机中断式运行

`ask_user_question` MUST 作为人机中断式交互运行，使用 `executionMode: 'human_interruption'` 声明，不受通用 `toolTimeoutMs` 超时约束。

#### Scenario: 等待不受普通工具超时影响

- **WHEN** 用户在提问界面停留超过普通工具执行超时阈值（默认 30 秒）
- **THEN** 系统 MUST 继续保持等待状态，而不是将其判定为普通工具超时而熔断

#### Scenario: 默认不自动超时

- **WHEN** 用户尚未回答 `ask_user_question`
- **THEN** 系统 MUST 默认持续等待，直到用户回答、用户取消、会话关闭或进程退出为止。框架不为该等待注入默认超时

#### Scenario: 外部取消仍通过 AbortSignal 传达

- **WHEN** 用户通过 Ctrl+C 或上层通过 `AbortController.abort()` 取消
- **THEN** AbortSignal 的 `abort` 事件传达到交互层，工具返回空字符串，CLI 层清理交互界面

### Requirement: 工具调用发起用户提问

agent 在推理过程中 MUST 能够通过调用 `ask_user_question` 工具向用户发起结构化提问。该工具属于只读操作（`securityCategory: 'read'`），执行模式为 `executionMode: 'human_interruption'`，不使用通用 `toolTimeoutMs` 超时约束。

#### Scenario: 固定选项单选提问

- **WHEN** agent 需要用户在预设选项中选择一项时，调用 `ask_user_question` 工具，传入 `title`（问题标题）、`options`（选项数组）、`multiSelect: false`
- **THEN** CLI 层暂停 agent 推理，渲染问题标题和选项列表（带序号），等待用户选择后返回所选选项的文本内容，agent 继续推理

#### Scenario: 固定选项多选提问

- **WHEN** agent 需要用户在预设选项中选择多项时，调用 `ask_user_question` 工具，传入 `title`、`options`、`multiSelect: true`
- **THEN** CLI 层渲染多选交互界面（带勾选/取消的多选项列表 + 确认按钮），用户确认后返回所有选中选项的文本，以约定分隔符拼接为单一字符串

#### Scenario: 自由文本输入提问

- **WHEN** agent 需要用户提供开放式回答时，调用 `ask_user_question` 工具，传入 `title`、`allowFreeInput: true`，`options` 为空或省略
- **THEN** CLI 层渲染问题标题和文本输入框，用户输入自由文本并确认后返回用户输入的原始文本

#### Scenario: 选项 + 自由输入混合模式

- **WHEN** agent 需要用户从选项中选择或输入自定义内容时，调用 `ask_user_question` 工具，传入 `title`、`options`（非空）、`allowFreeInput: true`
- **THEN** CLI 层渲染选项列表并在末尾追加 "Other（自定义输入）" 选项，用户选中 Other 后切换为文本输入框，最终返回选项文本或用户自定义输入

#### Scenario: 超时处理

- **WHEN** 用户在 CLI 展示提问后长时间未响应
- **THEN** 工具默认不设自动超时，等待仅在用户回答、用户取消、会话关闭或进程退出时结束。若业务层显式配置了超时，超时后工具返回空字符串，agent 自行决定后续行为

#### Scenario: AbortSignal 取消处理

- **WHEN** 工具执行被外部 `AbortSignal` 取消（如用户中断推理、会话销毁）
- **THEN** `InteractionPort.askUser()` 接收到 `signal` 的 abort 事件后立即终止等待，工具返回空字符串，CLI 层清理交互界面并恢复 InputListener。不得残留未清理的 stdin 监听器。**注意：通用工具超时熔断器（`toolTimeoutMs`）不应对 `ask_user_question` 生效；该工具的取消仅由用户手动中断、会话关闭或显式配置的超时触发**

### Requirement: 工具参数 Schema 定义

`ask_user_question` 工具的 OpenAPI Function Calling 声明 MUST 包含以下参数定义。

#### Scenario: 参数 schema 结构

- **WHEN** agent 请求可用工具列表
- **THEN** 工具声明包含 `title`（string，必填）、`options`（string[]，可选，默认为空）、`multiSelect`（boolean，可选，默认 false）、`allowFreeInput`（boolean，可选，默认 false）。当 `options` 为空且 `allowFreeInput: false` 时，参数校验失败

### Requirement: CLI 层交互渲染

CLI 层 MUST 监听 `ask_user_question` 工具调用并渲染与安全审批弹框明确区分的交互界面。

#### Scenario: 视觉区分于审批弹框

- **WHEN** CLI 检测到当前挂起为 `ask_user_question` 工具调用
- **THEN** 渲染的界面 MUST 使用与审批弹框（"此操作需要审批" 风格）不同的标题样式、提示语调和选项布局，确保用户能区分"系统在提问"和"系统在警告风险"

#### Scenario: 用户输入流转

- **WHEN** 用户在 CLI 交互界面中完成选择或输入
- **THEN** CLI 层将用户回答字符串通过 `InteractionPort` 返回给工具的 `execute()` 方法，工具将其作为工具调用结果返回给 agent-loop，注入到下一轮 LLM 推理的上下文中

### Requirement: InteractionPort 契约定义

系统 MUST 提供 `InteractionPort` 接口，作为工具层发起人机交互的挂起等待通道。

#### Scenario: askUser 方法契约

- **WHEN** 工具调用 `InteractionPort.askUser(payload)`
- **THEN** 系统挂起当前工具执行，将 payload（title、options、multiSelect、allowFreeInput）传递给 CLI 层渲染交互界面，等待用户响应后返回用户回答字符串并恢复工具执行。默认不设自动超时；若超时或用户取消，返回空字符串

#### Scenario: 与 ApprovalPort 职责分离

- **WHEN** 系统初始化端口层
- **THEN** `InteractionPort` 和 `ApprovalPort` MUST 为独立接口。`InteractionPort` 负责对话式提问，`ApprovalPort` 负责安全风险拦截。两者可在同一实现类中提供（如 `CliFacade`），但契约层面互不依赖
