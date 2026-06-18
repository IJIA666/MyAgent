## 1. 禁用 Immer 自动冻结机制

- [x] 1.1 在 [plugin-runner.ts](file:///d:/Projects/MyAgent/src/brain/plugins/plugin-runner.ts) 的文件头部从 'immer' 导入 `setAutoFreeze` 函数。
- [x] 1.2 在 [plugin-runner.ts](file:///d:/Projects/MyAgent/src/brain/plugins/plugin-runner.ts) 的顶级作用域中显式调用 `setAutoFreeze(false)`，全局禁用自动冻结。

<!-- checkpoint: npm run build -->

## 2. 静态检查与单元测试验证

- [x] 2.1 运行 ESLint 静态代码检查，确保无代码规范或导入问题。
- [x] 2.2 运行 Vitest 单元测试，验证修改后系统原有智能体大循环及插件机制能够顺利跑通。

<!-- checkpoint: npm run lint -->
<!-- checkpoint: npm run test -->
