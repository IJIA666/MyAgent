## 实施路径 (Execution Path)

- [x] 1. 建立 `src/brain/services/` 目录基础结构。
- [x] 2. 剥离并实装 `RuleManager`：抽取全局规则热加载逻辑，从 `session.ts` 移植 `loadRulesToCache` 等方法。
- [x] 3. 剥离并实装 `ContextRepository`：接管所有的文件系统交互（Session 落盘锁、状态读写 `saveState` 与 `loadState`）。
- [x] 4. 剥离并实装 `ToolDispatcher`：分离 JIT 上下文注入逻辑与长文本返回削峰器 `handleLargeToolOutput`。
- [x] 5. 剥离并实装 `CompactionService`：接管所有的异步触发提炼（`triggerAsyncCompactionIfNeeded`）与强制截断防爆逻辑。
- [x] 6. 主枢纽改写：重构 `SessionManager`，在构造函数中组装这四大服务，更新其 `run` 推理死循环内的调用指针。

<!-- checkpoint: npx vitest run test/brain -q -->
