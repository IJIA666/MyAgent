## ADDED Requirements

### Requirement: 显式会话模型选择不得被启动默认值覆盖

系统通过 `/model` 接收目标模型 profile 后，必须（MUST）使用该目标 profile 对应的 provider model 构建当前会话配置。进程启动时读取的 `AGENT_LLM_MODEL` 只能作为未发生显式选择时的默认值，不得反向覆盖本次会话选择。

#### Scenario: 从默认 flash 切换到 pro

- **WHEN** 进程以 `AGENT_LLM_MODEL=deepseek-v4-flash` 启动，用户在 `/model` 中选择 `deepseek-v4-pro`
- **THEN** 当前会话、LLM adapter 后续请求和成功反馈必须使用 pro profile 对应的实际 provider model，不得继续使用 flash

#### Scenario: 切换配置校验失败

- **WHEN** 目标 profile 缺少 API key、窗口值非法或配置构建失败
- **THEN** 系统必须保持切换前的完整有效配置，且不得输出“配置已生效”

### Requirement: 模型和上下文窗口必须原子选择并统一生效

系统必须（MUST）由模型 profile 声明其支持的上下文窗口。`/model` 向导仅在目标模型存在多个受支持窗口时展示窗口选择，并将 profile、provider model、context window 与 reasoning effort 作为一个有效配置原子应用到当前会话。

#### Scenario: 模型支持多个窗口

- **WHEN** 用户选择的目标 profile 声明了多个上下文窗口
- **THEN** 向导必须要求用户从声明值中选择一个窗口，并将该值同时用于会话状态、Token 预算和后续模型请求

#### Scenario: 模型只有一个窗口

- **WHEN** 用户选择的目标 profile 只声明一个上下文窗口
- **THEN** 向导不得展示无意义的窗口步骤，必须直接采用该 profile 的唯一窗口

#### Scenario: 用户取消任一步骤

- **WHEN** 用户在模型、窗口或 reasoning 选择阶段取消操作
- **THEN** 当前会话配置和默认配置文件都不得发生部分更新

### Requirement: 模型状态展示必须来自有效会话配置

系统必须（MUST）以切换完成后的有效 `LlmConfig` 作为模型名称、context window、Token 使用率和成功反馈的唯一事实来源，不得使用固定窗口值或仅复述用户输入。

#### Scenario: 切换后展示窗口使用率

- **WHEN** 当前会话切换到 context window 为 128000 的有效配置
- **THEN** UI 中窗口总量和使用率分母必须为 128000，且与 Token estimator 使用的窗口一致

#### Scenario: 实际 provider model 与 profile ID 不同

- **WHEN** profile ID 是面向用户的别名，而实际 API 请求使用另一 provider model 字符串
- **THEN** 状态和日志必须能够区分 profile ID 与实际 provider model，且成功提示不得声称未生效的模型
