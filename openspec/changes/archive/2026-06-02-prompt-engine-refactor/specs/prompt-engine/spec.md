## ADDED Requirements

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
