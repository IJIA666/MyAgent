# ask-user-question

## Purpose

提供 agent 向用户发起结构化提问的能力。该能力属于人机协作中的中断式交互：问题发出后，当前 run 进入等待用户输入的状态；用户回答后，从同一 run 恢复继续执行。

## 新增需求

### Requirement: 人机中断式提问

`ask_user_question` MUST 作为人机中断式交互运行，而不是作为普通同步工具在执行栈中长时间阻塞等待。

#### Scenario: 发起提问时进入等待用户输入状态

- **WHEN** agent 在推理过程中调用 `ask_user_question`
- **THEN** 系统 MUST 创建一个待回答的 interaction，暂停当前 run，并将问题载荷交给交互层渲染给用户

#### Scenario: 等待不受普通工具超时影响

- **WHEN** 用户在提问界面停留超过普通工具执行超时阈值
- **THEN** 系统 MUST 继续保持该 interaction 为待回答状态，而不是将其判定为普通工具超时

#### Scenario: 回答后恢复同一 run

- **WHEN** 用户完成选择或输入并提交回答
- **THEN** 系统 MUST 将该回答作为本次 `ask_user_question` 调用结果写回，并从同一 run 的中断点恢复后续执行

#### Scenario: 默认不自动超时

- **WHEN** 用户尚未回答 `ask_user_question`
- **THEN** 系统 MUST 默认持续等待，直到用户回答、用户取消、会话关闭或进程退出为止

#### Scenario: 会话结束时终止待回答交互

- **WHEN** 会话关闭、进程退出或恢复状态丢失
- **THEN** 系统 MUST 终止对应的待回答 interaction，并清理其挂起状态，不得继续把该问题当成普通工具执行中的等待

## 修改需求

### Requirement: 工具调用发起用户提问

agent 在推理过程中 MUST 能够通过调用 `ask_user_question` 工具向用户发起结构化提问。该工具属于只读操作（`securityCategory: 'read'`），并使用独立的人机交互链路，不与安全审批混用。

#### Scenario: 固定选项单选提问

- **WHEN** agent 需要用户在预设选项中选择一项时，调用 `ask_user_question`，传入 `title`、`options`、`multiSelect: false`
- **THEN** 交互层 MUST 渲染问题标题和选项列表，等待用户选择，并在提交后返回所选选项文本

#### Scenario: 固定选项多选提问

- **WHEN** agent 需要用户在预设选项中选择多项时，调用 `ask_user_question`，传入 `title`、`options`、`multiSelect: true`
- **THEN** 交互层 MUST 支持多项选择并在用户确认后返回所有选中项的约定结果

#### Scenario: 自由文本输入提问

- **WHEN** agent 需要用户提供开放式回答时，调用 `ask_user_question`，传入 `title`、`allowFreeInput: true`
- **THEN** 交互层 MUST 渲染文本输入能力，并在用户确认后返回原始输入文本

#### Scenario: 选项与自由输入混合模式

- **WHEN** agent 需要用户从选项中选择或输入自定义内容时，调用 `ask_user_question`，传入 `title`、`options`、`allowFreeInput: true`
- **THEN** 交互层 MUST 同时支持预设选项和自定义输入，并返回最终提交内容

#### Scenario: 用户取消提问

- **WHEN** 用户明确取消当前提问
- **THEN** 系统 MUST 结束该 interaction，向 run 返回取消结果或终止信号，并执行必要的挂起状态清理

### Requirement: 工具参数 Schema 定义

`ask_user_question` 工具的 Function Calling 声明 MUST 包含以下参数定义。

#### Scenario: 参数 schema 结构

- **WHEN** agent 请求可用工具列表
- **THEN** 工具声明 MUST 包含 `title`（string，必填）、`options`（string[]，可选）、`multiSelect`（boolean，可选，默认 false）、`allowFreeInput`（boolean，可选，默认 false）
- **AND** 当 `options` 为空且 `allowFreeInput: false` 时，系统 MUST 拒绝该无效提问参数

### Requirement: 交互界面与输入流转

交互层 MUST 渲染与审批明确区分的提问界面，并将用户输入路由回对应的待回答 interaction。

#### Scenario: 视觉区分于审批弹框

- **WHEN** 当前挂起的是 `ask_user_question`
- **THEN** 渲染界面 MUST 与安全审批在标题、提示语与交互布局上保持明确区分

#### Scenario: 用户输入写回挂起交互

- **WHEN** 用户在交互界面完成选择或输入
- **THEN** 交互层 MUST 将回答写回对应的待回答 interaction，并触发原 run 的恢复流程

### Requirement: 交互契约与审批分离

系统 MUST 为 `ask_user_question` 提供独立的人机交互契约，不得与 `ApprovalPort` 的职责混淆。

#### Scenario: 提问与审批分离

- **WHEN** 系统初始化工具交互能力
- **THEN** 提问类交互与审批类交互 MUST 在契约语义上分离；即使由同一实现类承载，也不得把提问流程当成审批流程的变体
