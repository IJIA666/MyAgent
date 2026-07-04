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

### Requirement: RULE_FILE_SANDBOX 措辞必须采用中性委托语义
`RULE_FILE_SANDBOX` 常量（`src/core/usecases/brain/prompts.ts`）的文本内容必须（MUST）使用中性委托语义，不得包含对工具执行结果的负面预判。

#### Scenario: 措辞不含执行结果预判
- **WHEN** 审查 `RULE_FILE_SANDBOX` 常量的文本内容
- **THEN** 文本不得包含"工具将返回拒绝访问错误""工具集会拒绝""操作将失败"等对工具执行结果的预判性声明

#### Scenario: 措辞包含正向委托指令
- **WHEN** 审查 `RULE_FILE_SANDBOX` 常量的文本内容
- **THEN** 文本应当（SHALL）包含指引模型"不要仅因路径位于工作区外而提前拒绝用户请求"或等效的正向行为指令，并明确将安全决策权委托给工具层

#### Scenario: 措辞保留默认边界信息
- **WHEN** 审查 `RULE_FILE_SANDBOX` 常量的文本内容
- **THEN** 文本应当（SHALL）声明文件操作的默认边界（工作区目录），以防止模型误以为工具具备无限制的全盘访问能力

#### Scenario: 单元测试同步更新
- **WHEN** 运行 `prompt.test.ts` 中的现有测试
- **THEN** 涉及 `RULE_FILE_SANDBOX` 文本内容的断言必须与新的措辞保持一致，测试不得因措辞变更而失败
