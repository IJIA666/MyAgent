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
