## 1. 容错与防御截断测试补全 (Test Implementation)

- [x] 1.1 在 `test/brain/plugins.test.ts` 中编写向量路故障容错测试 `should degrade to keyword search gracefully when vector search fails`，模拟嵌入生成抛错，断言物理关键字检索路能够平稳接管并召回，主流程正常向下传递。
- [x] 1.2 在 `test/brain/plugins.test.ts` 中编写用户输入超长硬截断单元测试 `should truncate latest user message to 2000 characters before embedding`，制造 2500 字符的大问询，验证 `generateEmbedding` 接口被调用时的参数被防御性缩减至 2000 字符。

<!-- checkpoint: npm run build -->

## 2. 静态审查与单元回归验证 (Static Checks & Verification)

- [x] 2.1 运行 `npm run build` 和 `npm run lint` 验证项目编译以及静态代码规范，确保测试代码无 unused variables。
- [x] 2.2 运行 `npm test` 启动 Vitest，执行全项目包含新加入补强测试的 175+ 个测试用例，确保全部 100% 成功通过。

<!-- checkpoint: npm test -->
