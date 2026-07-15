## 新增需求

### Requirement: 提示词常量抽取与物理隔离
系统提示词文件 `src/core/usecases/brain/prompts.ts` 中的核心红线指令必须（MUST）被提取为独立的 TypeScript 常量，实现物理层面的逻辑隔离，避免未来修改时互相污染。

#### Scenario: 规则常量定义
- **WHEN** 开发者打开 `src/core/usecases/brain/prompts.ts`
- **THEN** 应当能够清晰地定位到 `RULE_TOOL_RESULT_HANDLING` 等仍由提示词承担的独立规则常量定义。

### Requirement: 冷启动装配与序号自愈
模块冷启动加载时，系统提示词必须（MUST）通过规则常量数组动态 map 赋予序号并拼接生成最终的 `BASE_SYSTEM_PROMPT`。

#### Scenario: 冷启动一次性拼接
- **WHEN** Node.js 模块冷启动加载
- **THEN** 系统自动按照数组顺序拼接规则常量并生成序号，得到确定性的 `BASE_SYSTEM_PROMPT`。

### Requirement: 装配完整性与安全性验证
必须（MUST）编写对应的单元测试，对最终装配出的提示词文本进行安全校验与完整性校验。

#### Scenario: 单元测试校验
- **WHEN** 运行单元测试
- **THEN** 测试必须断言 `SYSTEM_RULES` 中的核心规则常量均被完整装配到 `BASE_SYSTEM_PROMPT`，且操作系统仅作为动态运行环境事实注入。

### Requirement: 运行环境提示必须只陈述实际事实
基础系统提示词不得（MUST NOT）无条件声明文件沙盒、授权工作区边界或工作区外路径的预期处理结果。当前工作目录必须（MUST）作为动态运行事实注入 `volatile_context`；如未来启用真实沙盒，相关能力说明必须由运行时状态按条件生成。

#### Scenario: 注入当前工作目录
- **WHEN** 使用当前工具执行目录组装系统提示词
- **THEN** `volatile_context` 必须包含该目录对应的 `<cwd>` 事实

#### Scenario: 不伪造沙盒或授权边界
- **WHEN** 当前运行时没有启用真实文件沙盒
- **THEN** 基础系统提示词不得包含“授权的工作区”“工作区外将被拒绝”或其他等价的沙盒与权限结果预判

#### Scenario: 单元测试验证事实边界
- **WHEN** 运行 `prompt.test.ts` 中的现有测试
- **THEN** 测试必须验证 CWD 被注入，且基础提示词不再包含文件沙盒或授权工作区暗示

### Requirement: 回复语言偏好按配置动态注入
系统 MUST 在未配置回复语言时不施加语言要求，并仅在用户显式配置语言偏好时动态注入对应的用户可见输出约束。语言约束 MUST NOT 声称控制模型的内部思考语言。

#### Scenario: 未配置语言偏好
- **WHEN** 应用配置未提供回复语言
- **THEN** 系统提示词不包含语言章节

#### Scenario: 已配置语言偏好
- **WHEN** 应用配置提供非空回复语言
- **THEN** 系统提示词要求以该语言进行回复、解释、注释和用户沟通
- **AND** 技术术语与代码标识符保留原文
