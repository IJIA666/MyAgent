## 1. 插件物理位置搬迁与内部直连重构

- [x] 1.1 将插件基础定义 ` src/brain/plugin-types.ts `、 注册中心 ` src/brain/plugin-registry.ts ` 以及运行器 ` src/brain/plugin-runner.ts ` 物理移动到 ` src/brain/plugins/ ` 目录下。
- [x] 1.2 创建 ` src/brain/plugins/index.ts ` 文件，统一作为插件包对外的单向出口，导出类型定义、运行器、注册表及四大具体插件。
- [x] 1.3 梳理并修改 ` src/brain/plugins/ ` 目录内所有源文件（ 包含 `plugin-runner.ts` 与四大业务插件 ），使其对内互相引用时一律采用具体的相对路径直接导入，完全切断对自身 `index.ts` 的引用，杜绝循环依赖。

<!-- checkpoint: npm run build -->

## 2. 外部级联更新与工程质量验证

- [x] 2.1 级联更新智能体核心大循环 ` src/brain/agent-loop.ts ` 中的引用路径，统一从包入口 `./plugins/index.js` 单向导入。
- [x] 2.2 级联更新会话管理器 ` src/brain/session.ts ` 中的引用路径，统一从包入口 `./plugins/index.js` 单向导入。
- [x] 2.3 级联更新单元测试文件 ` test/brain/plugins.test.ts ` 中的包引用路径。
- [x] 2.4 运行项目 Linter 规则检查，确认修改后的代码完美符合 ESLint 校验规范。
- [x] 2.5 运行 Vitest 单元测试，确保项目原有的 38 个用例全部通过且无运行时 `undefined` 风险。

<!-- checkpoint: npm run test -->
