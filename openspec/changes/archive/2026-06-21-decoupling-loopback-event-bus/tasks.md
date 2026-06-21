## 1. 测试物理路径解耦与并发写竞态漏洞消除

- [x] 1.1 改造 [contextLoader.ts](file:///d:/Projects/MyAgent/src/core/usecases/contextLoader.ts) 中的 `loadGlobalRules` 和 `loadLocalRules`，支持可选的 `customPath?: string` 路径参数以支持磁盘物理加载解耦。
- [x] 1.2 重构 [prompt.test.ts](file:///d:/Projects/MyAgent/test/session/prompt.test.ts) 测试套件，在文件头部通过 `vi.mock` 对 `contextLoader.ts` 的读盘接口进行打桩拦截，从而在测试中直接将 `loadGlobalRules`/`loadLocalRules` 的物理读盘屏蔽，使得 `buildSystemPrompt()` 与 `new SessionContext` 的构造函数内部物理调用均自动转化为无 I/O 的纯净内存 mock，彻底规避读写竞态。
- [x] 1.3 重构 [contextLoader.test.ts](file:///d:/Projects/MyAgent/test/brain/contextLoader.test.ts)，在 `beforeEach` 中使用 `os.tmpdir()` 配合 `fs.mkdtempSync` 创建每个测试用例隔离专有的沙箱文件夹，并在调用 `loadGlobalRules(tmpPath)` 时传入该沙箱路径参数，测试物理读取行为。
- [x] 1.4 清理并删除 [prompt.test.ts](file:///d:/Projects/MyAgent/test/session/prompt.test.ts) 中的 `beforeAll/afterAll` 对全局磁盘文件的备份恢复反模式，改用对 `buildSystemPrompt` 直接输入 Mock 内存参数或利用上述 `vi.mock` 进行规则装配与 XML 拼接断言。

<!-- checkpoint: npx vitest run test/brain/contextLoader.test.ts test/session/prompt.test.ts -->

## 2. SessionManager 事件分发与高内聚输入入口重构

- [x] 2.1 修改 [SessionManager](file:///d:/Projects/MyAgent/src/core/usecases/session.ts) 类使其继承 Node.js 原生的 `EventEmitter`，彻底删除原有的 `onAsyncEvent` 接口并将 `this.context` 设为 `private`，保障底座事件的物理隔离。
- [x] 2.2 收水 `addUserMessage` 物理接口。将其改造为 `private` 私有方法，同时分析并处理其对 [CliFacade](file:///d:/Projects/MyAgent/src/adapters/input/interface/facade.ts) 的调用链影响（如 L220 的追加消息），防止外部直接修改历史。
- [x] 2.3 在 [SessionManager](file:///d:/Projects/MyAgent/src/core/usecases/session.ts) 中实现全新的统一人类输入入口 `handleUserInput(input: string, transientSkillContent?: string): void`，该接口为 fire-and-forget 异步通知设计。
  - 实现同步原子加锁：在最前端同步判定并同步设锁 `isGenerating = true`，防止同 Tick 内由于异步 TOCTOU 竞争导致的重入，并重置自动唤醒熔断器。
- [x] 2.4 在 [SessionManager](file:///d:/Projects/MyAgent/src/core/usecases/session.ts) 推理大循环完毕的 `finally` 阶段释放忙锁，并在 `process.nextTick` 微任务回调中安全触发积压通知的自唤醒级联。
- [x] 2.5 移除 [SessionManager](file:///d:/Projects/MyAgent/src/core/usecases/session.ts) 内部 `runInternalGeneration` 顶部的冗余加锁行。
- [x] 2.6 在 [SessionManager](file:///d:/Projects/MyAgent/src/core/usecases/session.ts) 中提供标注 `@internal` 的 `__testEmitAsyncEvent(event: unknown): void` 辅助测试方法，并在 `willWakeup` 的事件处理分支中补齐非对称事件发射的 JSDoc 逻辑说明。

<!-- checkpoint: npx tsc --noEmit -->

## 3. 界面适配器与集成测试对齐改造

- [x] 3.1 重构门面适配器 [CliFacade](file:///d:/Projects/MyAgent/src/adapters/input/interface/facade.ts)，将其私有持有的推理锁与唤醒熔断逻辑彻底删除剥离，改由直接向 `SessionManager` 注册监听 `'agent_event'` 并被动渲染。
- [x] 3.2 对齐 [CliFacade](file:///d:/Projects/MyAgent/src/adapters/input/interface/facade.ts) 中的交互流程，将以往的多步调用合并修改为直接调用统一收水入口 `handleUserInput`。
- [x] 3.3 重构 [loopback.test.ts](file:///d:/Projects/MyAgent/test/session/loopback.test.ts) 集成测试套件，对齐 `SessionManager` 核心层级的自驱动唤醒与事件分发契约断言。
- [x] 3.4 重构门面适配器 [CliFacade](file:///d:/Projects/MyAgent/src/adapters/input/interface/facade.ts)，将私有属性 `isGenerating` 改名为 `isRendering` 以实现与大脑核心忙锁的命名隔离。
- [x] 3.5 重构 [loopback.test.ts](file:///d:/Projects/MyAgent/test/session/loopback.test.ts) 集成测试，使用 `__testEmitAsyncEvent` 测试辅助方法触发自唤醒逻辑，彻底剔除直接越权强转调用私有 `context` 的反模式。

<!-- checkpoint: npx vitest run -->
