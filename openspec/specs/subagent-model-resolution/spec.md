# subagent-model-resolution Specification

## Purpose

定义子代理模型的解析契约：优先级链（env > Agent 工具 `model` 参数 > 定义 frontmatter `model` > `inherit`）、值域限定（`inherit` 与 `BUILTIN_MODELS` 已注册 profile ID，未知值报错不静默回退）、profile 完整档案生效、exact-fork 始终继承父模型且不接受 model 参数的边界。对齐官方 `utils/model/agent.ts` 的 `getAgentModel` 优先级骨架；MyAgent 无 Claude 式族别名与 tier 体系，官方 alias 解析语义不在本能力范围。

## Requirements

### Requirement: 子代理模型按固定优先级解析

系统 MUST 按下述优先级解析子代理模型：环境变量 `MYAGENT_SUBAGENT_MODEL`（最高）> Agent 工具调用参数 `model` > 子代理定义 frontmatter `model` > `inherit`（默认）。模型值 MUST 为 `inherit` 或 `BUILTIN_MODELS` 中已注册的 profile ID；未知值 MUST 返回可诊断的校验错误，MUST NOT 静默回退父模型。解析结果 MUST 作为子代理独立 `LlmConfig` 冻结快照的一部分，且 MUST 不破坏既有"父会话切换模型不影响在途子代理"契约。

#### Scenario: 环境变量全局覆盖

- **WHEN** 环境变量 `MYAGENT_SUBAGENT_MODEL` 已设置
- **THEN** 所有子代理使用该模型，忽略工具参数与定义声明的 model
- **AND** 父模型切换不影响已冻结的子代理模型

#### Scenario: 工具参数优先于定义

- **WHEN** 定义 frontmatter 声明 `model: deepseek-v4-flash` 且调用传入 `model: deepseek-v4-pro`
- **THEN** 子代理使用 `deepseek-v4-pro`
- **AND** 同一类型的其他调用（未传参数）仍使用 `deepseek-v4-flash`

#### Scenario: 定义模型在无更高优先级时生效

- **WHEN** 自定义定义 frontmatter 声明 `model: deepseek-v4-flash` 且调用未传 `model`、环境变量未设置
- **THEN** 子代理使用 `deepseek-v4-flash`

#### Scenario: 缺省继承父模型

- **WHEN** 无环境变量、调用未传 `model` 且定义未声明 `model`
- **THEN** 解析结果为 `inherit`
- **AND** 子代理运行时使用父会话当前主循环模型的解析结果

#### Scenario: 未知模型 ID 返回校验错误

- **WHEN** 工具参数或定义声明了未注册的模型 ID（如 `haiku`）
- **THEN** 系统返回带稳定错误码的 `error` 结果，说明可用模型为 `inherit` 与已注册 profile ID
- **AND** 不创建任务或子代理循环

### Requirement: 已注册 profile ID 精确生效

系统 MUST 将解析得到的 profile ID 通过 `getModelConfig` 构造完整冻结 `LlmConfig`（含该 profile 的环境变量、baseUrl、contextWindow、temperature 与超时等完整档案），而非仅替换父配置的 model 字符串。构造时 MUST 禁用 `AGENT_LLM_MODEL` 环境覆盖（`allowEnvModelOverride: false`），避免显式指定模型被环境变量静默替换。`inherit` MUST 沿用父会话 `LlmConfig`。MyAgent 无 Claude 式族别名与 tier 体系，官方 `aliasMatchesParentTier` 语义不在本能力落地。

#### Scenario: profile ID 完整生效

- **WHEN** 子代理模型解析结果为已注册的 profile ID（如 `deepseek-v4-flash`）
- **THEN** 系统以该 profile 的完整档案构造冻结 `LlmConfig`
- **AND** 子代理使用独立客户端且父配置变化不影响该冻结配置

#### Scenario: 指定 profile 不受环境变量覆盖

- **WHEN** 模型解析结果为 `deepseek-v4-flash` 且环境变量 `AGENT_LLM_MODEL` 指向其他模型
- **THEN** 子代理仍使用 `deepseek-v4-flash` 的完整档案
- **AND** 不发生静默模型漂移

#### Scenario: inherit 沿用父配置

- **WHEN** 子代理模型解析结果为 `inherit`
- **THEN** 子代理沿用提交点冻结的父 `LlmConfig`
- **AND** 与阶段 1 行为保持一致

### Requirement: Agent 工具支持 model 参数

系统 MUST 使 `Agent` 工具 schema 声明可选 `model` 参数（`inherit` 或已注册 profile ID），并对非法值返回可诊断校验错误。exact-fork 语义下 `model` 参数 MUST NOT 生效：fork 始终继承提交时父模型配置，调用侧传入的 `model` 被忽略（fork 开关开启时 schema 不暴露该参数，与 `run_in_background` 一致）。

#### Scenario: 模型参数可见且可选

- **WHEN** 模型读取 `Agent` 工具 schema（fork 开关关闭）
- **THEN** schema 声明可选的 `model` 字段
- **AND** `required` 列表仍只有 `description` 与 `prompt`

#### Scenario: 非法 model 值返回校验错误

- **WHEN** 调用传入非字符串或空字符串的 `model`
- **THEN** 系统返回带稳定错误码的 `error` 结果
- **AND** 不创建任务或子代理循环

#### Scenario: fork 模式隐藏并忽略 model

- **WHEN** fork 配置开关开启
- **THEN** `Agent` schema 不含 `model` 字段
- **AND** 即使绕过 schema 传入 `model`，exact-fork 也使用提交时父模型配置

#### Scenario: 隐式 fork 不受 env 覆盖

- **WHEN** fork 开关开启且模型省略 `subagent_type` 隐式触发 exact-fork，同时环境变量 `MYAGENT_SUBAGENT_MODEL` 已设置
- **THEN** fork 子代理仍使用提交点冻结的父模型配置
- **AND** 环境变量不覆盖 fork 模型
