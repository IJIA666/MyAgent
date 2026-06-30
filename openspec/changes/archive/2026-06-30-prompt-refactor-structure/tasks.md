## 1. 系统提示词重构 (Prompts Refactoring)

- [x] 1.1 在 `src/core/usecases/brain/prompts.ts` 中提取 9 条核心红线指令为独立的 TypeScript 常量（如 `RULE_FILE_SANDBOX`、`RULE_ERROR_HANDLING` 等），并在常量定义上方书写轻量的职责注释。
- [x] 1.2 在该文件中定义包含全部 9 条规则常量的 `SYSTEM_RULES` 数组，用于集中式管理。
- [x] 1.3 改造 `BASE_SYSTEM_PROMPT` 的生成方式，使用 `SYSTEM_RULES` 数组通过 `map` 自动装配序号（`i + 1`），保证序号自愈。
- [x] 1.4 执行本地 TypeScript 编译，验证重构后无编译错误。

<!-- checkpoint: npm run build -->

## 2. 单元测试校验 (Unit Testing)

- [x] 2.1 在 `test/core/usecases/brain/prompt.test.ts` 中新增测试用例 7，断言最终装配生成的系统提示词文本中已不存在 `{{OS_SECURITY_INSTRUCTIONS}}` 占位符。
- [x] 2.2 在测试用例 7 中编写断言，校验所有导出的核心规则常量文本内容均被完整装配在最终的 `BASE_SYSTEM_PROMPT` 中，防范装配遗漏。
- [x] 2.3 执行 Vitest 单元测试，确保提示词相关的所有测试（包括新增的测试用例 7）全部通过。

<!-- checkpoint: npm run test -->
