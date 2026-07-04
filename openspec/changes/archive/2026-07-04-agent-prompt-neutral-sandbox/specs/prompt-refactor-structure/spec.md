## 新增需求

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
