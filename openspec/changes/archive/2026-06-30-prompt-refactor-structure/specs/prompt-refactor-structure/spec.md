## 新增需求

### Requirement: 提示词常量抽取与物理隔离
系统提示词文件 `src/core/usecases/brain/prompts.ts` 中的 9 条核心红线指令必须（MUST）被提取为独立的 TypeScript 常量，实现物理层面的逻辑隔离，避免未来修改时互相污染。

#### Scenario: 规则常量定义
- **WHEN** 开发者打开 `src/core/usecases/brain/prompts.ts`
- **THEN** 应当能够清晰地定位到诸如 `RULE_FILE_SANDBOX`、`RULE_TERMINAL_SAFETY`、`RULE_ERROR_ATTRIBUTION` 等 9 条独立的常量规则定义。

### Requirement: 冷启动装配与序号自愈
模块冷启动加载时，系统提示词必须（MUST）通过规则常量数组动态 map 赋予序号并拼接生成最终的 `BASE_SYSTEM_PROMPT`。

#### Scenario: 冷启动一次性拼接
- **WHEN** Node.js 模块冷启动加载
- **THEN** 系统自动按照数组顺序拼接规则常量并生成序号，最终生成的系统提示词在整个会话中固化只读，以确保 100% 兼容前缀缓存（Prefix Cache）。

### Requirement: 装配完整性与安全性验证
必须（MUST）编写对应的单元测试，对最终装配出的提示词文本进行安全校验与完整性校验。

#### Scenario: 单元测试校验
- **WHEN** 运行单元测试
- **THEN** 测试必须断言最终的 `BASE_SYSTEM_PROMPT` 中不含有冷启动替换占位符（如 `{{OS_SECURITY_INSTRUCTIONS}}`），且 9 条核心规则常量均被完整无缺地装配到了最终的提示词文本中。
