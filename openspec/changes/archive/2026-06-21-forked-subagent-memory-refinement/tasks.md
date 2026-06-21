## 1. 特化记忆写工具及隔离注册表

- [x] 1.1 实现一个实现了 `ToolRegistryPort` 的 `MemoryRefinementToolRegistry` 受限工具注册表类， 限制其仅且唯一提供 `writeMemoryFile` 工具。
- [x] 1.2 在其中实现 `writeMemoryFile` 工具， 接收 `content` 事实内容， 锁死写入到 `.agent/MEMORY.md` 路径， 显式将其 `securityCategory` 设为 `'safe'`（ 规避 PostRunHook 的代码编译/Lint 检查 ）， 并通过构造函数接收的写入函数 `writeMemoryFn: (content: string) => Promise<void>` 代理追加写入， 斩断与插件实例的强耦合。

<!-- checkpoint: npm run build -->

## 2. 插件事件解耦与写逻辑剥离

- [x] 2.1 修改 `LongTermMemoryPlugin` 构造函数， 支持传入可选的自省提炼回调 `onSessionEndCallback?: (history: ChatMessage[]) => void`。
- [x] 2.2 重构 `LongTermMemoryPlugin.ts`：
  - 彻底剥离并移除其内部持有的 `writeQueue` 属性与 `queueWrite()` 写盘方法。
  - 重构 `SessionEnd` 钩子， 过滤逻辑通过后， 直接触发此回调函数将历史消息向上传递， 移除直接在大循环插件中调用 LLM 和写盘的行为。

<!-- checkpoint: npm run build -->

## 3. Session 协调层托管 Fork 与 ReAct 自省驱动

- [x] 3.1 在 `src/core/usecases/session.ts` 的 `SessionManager` 中声明并实现 `writeQueue` 互斥写入 Promise 链及 `queueWrite(text)` 物理追加写盘方法。
- [x] 3.2 在 `SessionManager` 构造函数中， 注册 `LongTermMemoryPlugin` 时传入自省事件提炼回调。
- [x] 3.3 在 `SessionManager` 中新增异步派生自省方法 `triggerMemoryRefinementAsync(history: ChatMessage[])`， 在后台异步（ 非阻塞主线程 ） 任务中执行。
- [x] 3.4 在 `SessionManager` 中实现 `runMemoryRefinementSubAgent(history)` 方法：
  - 动态构建隔离的 `SessionContext` 沙箱上下文， 并压入自省 Initial User Prompt。
  - 创建隔离的 `MemoryRefinementToolRegistry` 注册表（ 传入 `this.queueWrite` 回调代理 ）， 并实例化专用的沙箱追踪器 `AgentTracer(process.cwd(), ...)`。
  - 实例化受限的子 `AgentLoop` 实例， 限制 `maxIterations` 上限。
  - 通过 `for await` 循环消费 `AgentLoop.chat()` 异步生成器， 驱动子智能体独立流转并调用 `writeMemoryFile` 完成安全自省落盘。

<!-- checkpoint: npm run build -->

## 4. 单元测试与质检集成

- [x] 4.1 在 `test/brain/plugins.test.ts` 中编写集成与单元测试用例， 验证通过回调机制由 `SessionManager` 异步拉起 Forked Agent 运转， 并成功以 ReAct 推理、 调用工具落盘记忆及正常注销全流程。
- [x] 4.2 运行编译构建、 全量 `eslint` 静态代码质检和 `vitest` 全量单元测试， 确保全部通过。

<!-- checkpoint: npm test -->
