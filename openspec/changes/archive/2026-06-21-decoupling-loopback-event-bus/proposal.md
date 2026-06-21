## 改造原因

说明本次变更的动机：
1. **测试物理并发竞态**：目前 [contextLoader.test.ts](file:///d:/Projects/MyAgent/test/brain/contextLoader.test.ts) 和 [prompt.test.ts](file:///d:/Projects/MyAgent/test/session/prompt.test.ts) 均硬编码读写全局的 `.agent/global_rules.md` 等物理规则文件，在 Vitest 并行测试下会发生严重的并发写竞态冲突（Race Condition），导致单元测试套件随机发生断言失败。且测试套件的 `beforeAll/afterAll` 备份恢复机制在并发模式下容易固化脏数据。
2. **主动唤醒机制的适配器强耦合**：异步终端任务触发的主动唤醒闭环（包括推理忙锁 `isGenerating`、熔断计数器 `autoWakeupCount` 以及积压缓冲通知 `hasPendingAsyncNotification`）目前完全实现在交互输入适配器 [CliFacade](file:///d:/Projects/MyAgent/src/adapters/input/interface/facade.ts) 中，使得该机制在 Web UI、IDE 插件等多端适配器中无法复用，破坏了六边形架构的核心原则。

## 变更内容

描述具体会发生哪些变化：
1. **测试路径解耦与竞态消除**：
   - 改造 [contextLoader.ts](file:///d:/Projects/MyAgent/src/core/usecases/contextLoader.ts) 中的 `loadGlobalRules` 和 `loadLocalRules`，支持接收可选的 `customPath?: string` 路径参数以支持物理文件加载解耦。
   - 重构 [contextLoader.test.ts](file:///d:/Projects/MyAgent/test/brain/contextLoader.test.ts)，使用 `os.tmpdir()` 创建独立沙箱文件夹进行测试隔离。
   - 重构 [prompt.test.ts](file:///d:/Projects/MyAgent/test/session/prompt.test.ts)，在测试头部使用 `vi.mock` 对 `contextLoader` 实施模块级打桩拦截。使 `buildSystemPrompt` 与 `new SessionContext` 的内部物理读盘均转换为纯净的内存 mock 执行，从而确保零生产代码污染且实现物理路径解耦。
2. **唤醒与熔断控制器下沉**：
   - 将 `isGenerating` 忙锁、`autoWakeupCount` 熔断计数和 `hasPendingAsyncNotification` 积压标记从控制台适配器层彻底下沉剥离。
   - [SessionManager](file:///d:/Projects/MyAgent/src/core/usecases/session.ts) 继承 `EventEmitter` 扮演上层交互事件广播中枢（Driving Event），对外分发统一的 `'agent_event'` 流；大循环自驱动推理的控制生命周期彻底解耦回 Core 内部，废除原有的 `onAsyncEvent` 监听器接口。
3. **人类交互入口收水统一**：
   - 暴露全新的统一人类输入入口 `handleUserInput(input, transientSkillContent?)` 代替原有的 `addUserMessage` + `chat` 暴露接口，保证在外部输入时最前端同步清空熔断器并将忙锁置为忙碌。
   - 在推理完毕后在 `finally` 阶段，利用 `process.nextTick`（或微任务隔离）进行级联唤醒调度防同步递归栈溢出，在当前单 Adapter 交互模式下保证时序安全性。

## 业务能力

本次改动纯属底层技术架构与测试稳定性重构，业务层面的需求规格未发生变化。

### 新增业务能力
- 无

### 修改业务能力
- 无

## 影响范围

评估受影响的代码、API、依赖、系统：
1. **加载逻辑**：[contextLoader.ts](file:///d:/Projects/MyAgent/src/core/usecases/contextLoader.ts) 中的规则读取接口需要支持可选的自定义路径参数。
2. **应用层服务**：[SessionManager](file:///d:/Projects/MyAgent/src/core/usecases/session.ts) 继承应用级事件广播与生命周期状态自驱动，废除原有的 `onAsyncEvent` 监听器，暴露统一人类输入接口 `handleUserInput`。
3. **入口适配器**：[CliFacade](file:///d:/Projects/MyAgent/src/adapters/input/interface/facade.ts) 需要剥离推理相关状态和唤醒时序控制逻辑，由“直接消费 Generator”改为“全局订阅 `SessionManager` 的 `agent_event`”执行界面渲染。
4. **集成与单元测试**：
   - 单元测试 [contextLoader.test.ts](file:///d:/Projects/MyAgent/test/brain/contextLoader.test.ts)（传入自定义物理路径）和 [prompt.test.ts](file:///d:/Projects/MyAgent/test/session/prompt.test.ts)（使用 `vi.mock` 物理打桩拦截）；
   - 现有的集成测试 [loopback.test.ts](file:///d:/Projects/MyAgent/test/session/loopback.test.ts) 需对齐 `SessionManager` 自驱动与事件订阅方式重构。
