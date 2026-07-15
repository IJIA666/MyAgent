# Purpose
提供基础的人设 Prompt 管理模块与接口抽象层，实现文本与业务调度中心的解耦，为未来接入动态上下文（如本地环境探测、MCP 工具注入）提供物理锚点。

## Requirements

### Requirement: Prompt Externalization
系统必须将核心的人设（System Prompt）文本存放在专属的管理模块（如 `src/brain/prompts.ts`）中，严禁在业务逻辑流 `SessionManager` 中进行硬编码。

#### Scenario: System accesses prompt text
- **WHEN** 系统启动大模型会话上下文时
- **THEN** 它能够从独立的 `prompts.ts` 模块中无损获取完整的人设文本片段

### Requirement: Prompt Builder Interface
系统必须提供统一的构建接口（如 `buildSystemPrompt` 函数），对外抽象化屏蔽 Prompt 的组装细节。

#### Scenario: Building basic system prompt
- **WHEN** `SessionManager` 在初始化历史上下文栈时
- **THEN** 调用 `buildSystemPrompt()` 获取初始化文本，而非自己手工拼装字符串

### Requirement: 操作系统信息仅作为运行环境事实
系统提示词引擎必须将当前操作系统作为运行环境事实注入，且不得在基础提示词中维护按平台分支的 Shell 能力、安全规则或语法禁用列表。Shell 工具可用性、语法分析与权限结果必须以当次工具注册和运行时策略为准。

#### Scenario: 注入宿主操作系统事实
- **WHEN** 系统调用 `buildSystemPrompt()` 组装提示词
- **THEN** `volatile_context` 必须包含当前宿主操作系统对应的 `<os>` 事实

#### Scenario: 不注入静态 Shell 平台矩阵
- **WHEN** 系统组装稳定基础提示词
- **THEN** 基础提示词不得包含按 Windows、macOS 或 Linux 分支维护的 Shell 能力与语法禁用列表

### Requirement: 基础提示词必须约束回答聚焦性与可执行性

系统基础提示词必须（MUST）要求 AI 直接围绕当前目标和已有证据作答，优先输出具体发现、适用范围、未知项和下一步判定条件。提示词必须明确禁止用常识复述、无筛选候选清单、模板化风险提示或"建议进一步优化"等空泛表达代替问题分析。

#### Scenario: 有具体证据时先陈述发现

- **WHEN** 当前上下文包含与用户目标直接相关的有效证据
- **THEN** AI 必须先给出证据支持的具体结论及范围，再给出必要的下一步，不得先铺陈通用背景

#### Scenario: 证据不足时明确未知项

- **WHEN** 当前证据不足以回答用户要求的范围
- **THEN** AI 必须指出具体缺失的目标或指标以及获取方式，不得用泛泛建议填充答案

#### Scenario: 建议必须包含触发条件

- **WHEN** AI 提出后续操作或改进建议
- **THEN** 建议必须说明针对哪个已知问题、依据是什么、在什么条件下执行以及如何判断完成

#### Scenario: 禁止无筛选的长候选清单

- **WHEN** 模型只能枚举潜在原因但无法依据当前证据排序
- **THEN** 回答必须将其明确标为未验证候选并限制数量，优先说明如何区分，而不是堆砌通用可能性
