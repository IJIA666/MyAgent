## 1. 网页文本提取工具开发与底座注册

- [x] 1.1 在 `src/action/tools/browser/browser-action.ts` 中新增并导出 `BrowserGetTextTool` 类，实现 `NativeTool` 契约，设定 `securityCategory` 为 `"read"`。
- [x] 1.2 编写该工具的 `definition` 属性，在其 JSON Schema 描述中着重以强警告语气规制智能体在可能遇到长文时必须提供精准的 CSS 选择器，避免大面积提取 body。
- [x] 1.3 实现 `execute` 方法，通过 `locator.all()` 提取匹配元素，对每个可见元素获取 `innerText()`，将结果以 `\n\n` 拼接，并调用 `.slice(0, 80000)` 执行硬性字符截断防御。
- [x] 1.4 在 `src/action/virtual-mcp.ts` 中导入 `BrowserGetTextTool` 并在 `LocalFileSystemMcpServer` 的 `allTools` 列表中进行实例化注册。

<!-- checkpoint: npm run build -->

## 2. 编写集成测试与质量验证

- [x] 2.1 在 `test/action/browser-action-multitenant.test.ts` 中编写集成测试，覆盖多元素匹配合并、默认 body 提取及 80k 字符物理截断测试、选择器匹配缺失的错误捕获场景。
- [x] 2.2 运行静态代码规范审查，清除任何 Lint 问题或未导出 TS 报错。
- [x] 2.3 运行全量测试用例（`npm run test`），验证新增工具的正确性，并确保多租户隔离、Stdin 输入流还原等既有功能无任何回归。

<!-- checkpoint: npm run test -->
