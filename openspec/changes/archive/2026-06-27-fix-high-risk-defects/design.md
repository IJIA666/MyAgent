## 背景

在对项目进行底座审计时，发现并确认了 3 个阻断性的高危技术缺陷：
1. **H-1**：`contextLoader.ts` 存在硬编码物理绝对路径，且与 `RuleManager` 对规则的加载职责重叠、割裂；模块级的全局有状态缓存 `skillsCache` 会导致在并发多会话（多个不同工作区）运行时，发生跨会话的技能交叉污染。
2. **H-2**：系统通知基于 `process.nextTick` 异步刷入，导致其执行时机与 Immer 的不可变覆写逻辑之间丧失了同步确定性。在连续 Hooks 同 Tick 同步执行时，未合并通知的历史会被新 Draft 引用，并在 Hook 结束时通过 `updateHistory` 将推入的历史完全覆盖抹除。
3. **H-3**：`DefaultContextAdapter` 将 `recentFiles` 包装为 `system` 角色消息强行插入到消息流中部（紧跟在 `user` 角色 Checkpoint 消息后），形成了不符合 OpenAI Spec 规范的非法交错消息序列，引发部分严格校验的 LLM 端点直接崩溃。

## 目标与非目标

**目标:**
- 将 `contextLoader.ts` 重构为纯无状态工具函数，彻底消除对特定物理绝对路径的硬编码，并将其生命周期及缓存管理收归至 `RuleManager` 实例中，实现并发多会话下技能系统的物理隔离。
- 废除 `process.nextTick` 异步落盘，构建纯同步的数据合并流，在 `AgentLoop` 每一轮交互周期的确定同步位置将暂存的通知刷入历史，保障消息 100% 递达且绝不被 Immer 覆盖。
- 将 `recentFiles` 作为 XML 数据物理附加到 Checkpoint 的 `user` 角色消息中，确保 LLM 消息流严格符合 system 首位、user/assistant 交替的 API 契约，实现 100% 平台兼容。
- 确保重构不破坏项目的现有测试，并新增相关针对性测试用例。

**非目标:**
- **坚决不修改** M-1、M-2 以及 L-1 到 L-5 等中低危缺陷，将精力严格聚焦在高危缺陷闭环上，严防范围蔓延。
- **坚决不对**核心插件分发机制（`plugin-runner.ts` 内部 dispatch 管道）进行侵入性的重构，仅在会话模型和主循环的关键声明周期挂钩点进行状态同步。
- **坚决不引入**任何外部动态配置中心、服务发现或第三方消息队列组件，保持极简轻量级设计。

## 架构决策

### 决策一：将技能扫描与缓存收归至 `RuleManager` 实例，`contextLoader` 彻底无状态化
* **决策理由**：并发多会话下，全局模块级的 `skillsCache` 会导致严重的缓存竞态和安全越权。通过将扫描到的技能存入 `RuleManager` 的实例变量，利用依赖注入在 `Session` 维度实现天然的物理隔离。`contextLoader.ts` 仅保留纯底层文件 I/O 能力。
* **替代方案**：保持全局 `skillsCache`，通过 `Map<workspacePath, SkillMetadata[]>` 隔离。
* **否决原因**：全局 Map 生命周期难以管控，无法优雅处理工作区变更或缓存清理，增加无谓内存驻留。

### 决策二：使用暂存队列与同步合并机制替代 `process.nextTick` 异步通知机制
* **决策理由**：取消隐式的 Event Loop 时序依赖。Hook 执行期间，所有通知追加操作一律塞入会话实例内部的 `pendingNotifications` 队列；在 `AgentLoop` 运行交互的主循环内，在所有 Hook 结束且在最终执行 `saveState()` 前，显式且同步地触发一次 flush 操作，合并入历史并完成持久化，彻底杜绝 Immer 覆写带来的竞态覆盖。
* **替代方案**：在 Immer 的 `updateHistory` 内部做深层差异比对和增量合并。
* **否决原因**：比对逻辑复杂且对于追加型历史记录的维护成本过高，容易引入二次缺陷。

### 决策三：将 `<recent_files_inventory>` 作为 XML 片段物理追加至首条 user 消息（Checkpoint）内容尾部
* **决策理由**：规避 Spec 兼容性风险最彻底的方案。由于物理合并到了已有消息的内容中，没有增加任何多余的 message 节点，完美规避了连续 `user` 消息或非法 `system` 消息位置触发的校验拦截。
* **替代方案**：把 `recentFiles` 包装为 user 消息，通过 splice 插入。
* **否决原因**：会产生连续的 user 消息节点，部分严格校验 API（如私有代理大模型或特定国产模型）对此会以 400 校验错直接拒绝请求。

## 风险与权衡

* **[风险一] 构造时序崩坏风险**：在 `SessionContext` 的构造阶段，系统提示词 `buildSystemPrompt` 会在没有 `appConfig` 时期被调用。如果 `loadSkills` 强制要求传入 `workspacePath` 参数，此时可能会传入 `undefined` 或报错。
  * *缓解策略*：在 `SessionContext` 构造时，系统 Prompt 中的技能列表暂时允许缺省或只加载空列表，而在 `RuleManager` 实例化时（此时 `appConfig` 注入完毕，工作区路径已确定），通过调用 `context.updateSystemPrompt` 自动刷新并重构完整的系统 Prompt。
* **[风险二] 异步任务结束时的通知挂起风险**：若交互结束后，有异步后台任务才刚刚运行完并生成通知消息，该消息会停留在 `pendingNotifications` 中。
  * *缓解策略*：在 `SessionContext` 实例被下次唤醒时，或在外部任务管理器事件总线监听到 `async_event` 并触发新一轮交互的开始时，首先强行进行一次 flush 操作，保证消息历史的及时同步。
