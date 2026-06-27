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

### Requirement: 系统人设自适应平台装配
系统提示词引擎必须能够自动依据当前宿主主机的物理操作系统类型，将通用静态提示词模板中的 `{{OS_SECURITY_INSTRUCTIONS}}` 占位符，自适应地在模块初始化阶段替换为对齐当前宿主操作系统的特定安全规则指示，消除平台冲突。

#### Scenario: 平台处于 Windows 环境
- **WHEN** 宿主物理操作系统 `process.platform` 为 `win32` 且模块被加载导入时
- **THEN** 系统提示词只读常量 `RESOLVED_BASE_PROMPT` 中必须自适应包含 Windows 原生命令红线及复合符号阻断约束。

#### Scenario: 平台处于 macOS 或 Linux 环境
- **WHEN** 宿主物理操作系统 `process.platform` 探测为 `darwin` 或 `linux` 且模块被加载导入时
- **THEN** 系统提示词只读常量 `RESOLVED_BASE_PROMPT` 中必须自适应包含 POSIX 规范与防命令注入逃逸约束，绝不能出现 Windows 字眼与特有命令限制。
