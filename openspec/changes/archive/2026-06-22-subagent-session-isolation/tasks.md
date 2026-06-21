## 1. 瞬态不落盘机制开发 (Transient Session Implementation)

- [x] 1.1 改造 `ContextRepository.ts` 的构造函数与 JSDoc，将 `isTransient = false` 作为可选的第三参数放置于构造签名最末尾，以兼容原有的单参数与双参数构造调用形式；在 `saveState()` 顶部添加拦截，当 `isTransient` 为 `true` 时静默返回不做写盘。
- [x] 1.2 改造 `session.ts` 中的 `runMemoryRefinementSubAgent()` 方法，在实例化子智能体所持有的 `subContextRepo` 时传入参数：`new ContextRepository(subContext, undefined, true)`。

<!-- checkpoint: npm run build -->

## 2. 单元测试补全与回归验证 (Testing & Verification)

- [x] 2.1 编写 `test/brain/ContextRepository.test.ts` 新的单元测试，验证当 `isTransient` 选项设定为 `true` 时，执行 `saveState()` 后物理磁盘上不创建任何 `.json` 会话文件，且 `loadState()` 状态等行为不受干扰。
- [x] 2.2 运行 `npm run build` 和 `npm run lint` 验证项目代码编译和静态 ESLint 检查。
- [x] 2.3 运行 `npm test` 启动 Vitest 回归测试，确保全量 175+ 个用例 100% 成功通过，不引入任何功能缺陷。

<!-- checkpoint: npm test -->

## 3. 测试全局物理沙箱隔离 (Test Sandbox Isolation)

- [x] 3.1 创建 `test/setup.ts` 脚本，在测试加载前动态在项目内部的 `.myagent/temp/` 目录下建立专属测试沙箱，并硬编码写入固定测试 facts 数据，重定向 `AUTHORIZED_WORKSPACE_DIR`，且在 `afterAll` 时自动销毁。
- [x] 3.2 改造 `vitest.config.ts` 配置文件，引入 `setupFiles: ['./test/setup.ts']` 确保全局测试对沙箱隔离生效。
- [x] 3.3 改造 `ContextRepository.ts` 内部 `saveState()` 和 `loadState()` 路径构建方法，统一引入对 `AUTHORIZED_WORKSPACE_DIR` 的读取，确保其受测试沙箱重定向覆盖。
- [x] 3.4 改造 `session.ts` 内部构造函数 (L117),会话重置 (L261) 与子 Agent 实例化 (L607) 这三处 `AgentTracer` 实列化传入的基准路径，统一改用 `AUTHORIZED_WORKSPACE_DIR`。
- [x] 3.5 物理清空物理工作区在测试中残留的 `.myagent/sessions/` 和 `.myagent/traces/` 下的全部垃圾临时文件，运行 `npm test` 回归验证测试正常，且物理工作区无任何物理文件及目录生成副作用。

<!-- checkpoint: npm test -->
