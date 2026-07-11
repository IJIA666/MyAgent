# dynamic-model-selection

## Purpose
支持系统维护多套模型预设字典，并提供在对话交互过程中通过 `/model` 命令实现当前会话大模型热切换的能力。

## Requirements

### Requirement: 内置多模型配置字典
系统必须（MUST）维护一套内置的知名模型配置参数表。每个模型条目应当包含其对应的唯一 ID、目标厂商 Base URL 对应的环境变量键名、API Key 对应的环境变量键名，以及生成特化请求 Payload 的策略。
此生成 Payload 的策略函数 `buildExtraPayload` 必须（MUST）支持接收动态的运行时配置上下文（例如思考等级等运行时参数），以便根据用户向导中的选择灵活生成特化请求载荷。

#### Scenario: 查询并应用目标模型
- **WHEN** 用户或系统需要激活 `gpt-4o` 这一模型时
- **THEN** 系统必须从预置的配置表中找到 `gpt-4o` 对应的配置，明确应该读取 `OPENAI_API_KEY` 而非其它 Key，并构建对应的客户端实例。

#### Scenario: 动态应用运行时特定模型参数
- **WHEN** 模型切换向导传递了特定的思考等级参数（如 `{ reasoning_effort: 'high' }`）给会话管理器
- **THEN** 在向大模型发起请求时，该模型的 `buildExtraPayload` 必须严格按照 API 文档规范组装含有 `thinking: { type: "enabled" }` 及 `reasoning_effort: high` 的顶层载荷，且仅暴露有效级别（high/max）。

### Requirement: 动态模型切换指令拦截
系统交互层必须（MUST）提供截获和处理以 `/` 字符开头的 Slash Command 机制。对于 `/model` 命令，系统应当（SHALL）调起交互式的 UI 向导。
向导必须允许用户在所有可用模型中选择，并在必要时展示相关高级参数的子选项。系统应当验证操作的合法性并在环境凭据允许的情况下更新当前会话使用的模型及相关运行时参数。

#### Scenario: 用户发起模型切换
- **WHEN** 用户在会话 REPL 提示符下输入 `/model deepseek-v3`
- **THEN** 系统拦截该输入（不视为对话内容），从环境变量中确认其 API Key 存在，将当前会话引擎的目标模型重置为对应配置，并输出类似“已成功切换至模型 deepseek-v3”的提示；若 Key 缺失则提示环境未配置。

#### Scenario: 用户发起交互式模型切换
- **WHEN** 用户在会话 REPL 提示符下输入 `/model`
- **THEN** 系统必须完全销毁当前的 `readline` 实例以彻底释放终端 `stdin` 控制权，然后弹出选择列表供用户选择目标模型，选择完成后将目标配置更新至会话引擎，并重新初始化一个新的 `readline` 实例以恢复常规对话提示符。

### Requirement: 显式会话模型选择不得被启动默认值覆盖

系统通过 `/model` 接收目标模型 profile 后，必须（MUST）使用该目标 profile 对应的 provider model 构建当前会话配置。进程启动时读取的 `AGENT_LLM_MODEL` 只能作为未发生显式选择时的默认值，不得反向覆盖本次会话选择。

#### Scenario: 从默认 flash 切换到 pro

- **WHEN** 进程以 `AGENT_LLM_MODEL=deepseek-v4-flash` 启动，用户在 `/model` 中选择 `deepseek-v4-pro`
- **THEN** 当前会话、LLM adapter 后续请求和成功反馈必须使用 pro profile 对应的实际 provider model，不得继续使用 flash

#### Scenario: 切换配置校验失败

- **WHEN** 目标 profile 缺少 API key、窗口值非法或配置构建失败
- **THEN** 系统必须保持切换前的完整有效配置，且不得输出"配置已生效"

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
