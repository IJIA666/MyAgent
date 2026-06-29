## 1. 监听重载防抖实现

- [x] 1.1 **防抖定时器声明**： 在 `src/core/usecases/brain/RuleManager.ts` 中声明私有的 `watchDebounceTimer: NodeJS.Timeout | null` 属性，用于追踪当前正在挂起的重载定时任务。

- [x] 1.2 **防抖合并实现**： 在 `RuleManager.ts` 的 `initSkillsWatcher` 中，对 `watch` 回调引入 100ms 的防抖合并，合并并发文件通知。

- [x] 1.3 **防抖专项测试编写**： 在 `test/core/usecases/brain/RuleManager.test.ts` 中，编写针对防抖行为的专属单元测试。使用 `vi.useFakeTimers()` 与 `vi.advanceTimersByTime(100)` 模拟高频连续文件变更，断言 `reloadRules`（或实际刷新逻辑）仅被调用了一次。

- [x] 1.4 **本地单测运行**： 执行并通过所有 `RuleManager` 相关的单元测试。

<!-- checkpoint: npm run test -->

## 2. 稳定性全局集成验证

- [x] 2.1 **全局测试回归**： 运行项目中所有集成测试，确保本次热重载防抖优化不破坏系统的全局正常执行流。

<!-- checkpoint: npm run test -->
