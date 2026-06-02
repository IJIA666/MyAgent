## ADDED Requirements

### Requirement: Theme Output Formatting
系统必须提供统一的 `theme` 模块，负责将标准字符串包装为对应的带样式（如 ANSI 控制符）视觉表现字符串。

#### Scenario: Apply success style
- **WHEN** 系统需要向终端打印成功提示信息时
- **THEN** 调用层得到已被正确赋予绿色高亮及复位控制符的完整字符串

#### Scenario: Apply dim style
- **WHEN** 系统需要向终端打印非核心追踪信息（如大模型思考过程）时
- **THEN** 调用层得到已被赋予暗灰色外观的完整字符串

### Requirement: Business Logic Isolation
业务控制流代码（如 `command.ts`, `SessionManager` 等）中严禁出现任何硬编码的终端样式控制常量（如 `\x1b[...`）。

#### Scenario: Business logic outputs text
- **WHEN** `command.ts` 生成指令结果文本时
- **THEN** 它必须将裸文本传递给 `theme.*` 语义化函数进行包裹，而非通过直接拼接终端控制码产生结果
