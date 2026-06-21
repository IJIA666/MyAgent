## 背景

第一阶段完成了以 JSDoc/TSDoc 强类型编写的拦截器插件核心， 实现了 `.agent/MEMORY.md` 的召回。
为了彻底规避在主上下文提炼自省时可能由于用户恶意的 Prompt 注入导致主智能体误删/误改其它工程文件的越权风险， 第二阶段采用**子智能体沙箱隔离设计**。 
同时， 为了规避依赖倒置与循环依赖（ 插件层不持有写队列及 ReAct 推理， 且工具注册表不应反向耦合插件 ）， 插件层退化为纯事件/回调发射器， 实际的 Fork 任务和物理写队列由宿主 `SessionManager` 统一托管。

## 架构决策

### 1. 插件与 ReAct 执行流的事件解耦 ( 只读/拦截 )
*   **决策**： `LongTermMemoryPlugin` 变为**纯只读与拦截插件**。 
    - `BeforeModel` 钩子中同步读取并召回注入。
    - `SessionEnd` 钩子中仅负责进行前置的对话复杂度判定。
*   **回调设计**： 插件构造函数接受自省提炼回调 `onSessionEndCallback`， 判定通过后将历史消息抛出， 插件内部的写队列 `writeQueue` 与写方法 `queueWrite` 彻底剥离并移交至 Session 层。

### 2. Session 协调层托管 Fork 与子智能体驱动 ( 状态/写入 )
*   **决策**： 在 `SessionManager` 中统一维护 `writeQueue: Promise<void>` 互斥排队写队列与 `queueWrite(text)` 物理写盘方法， 确保并发写入安全。
*   **驱动逻辑**： 
    - 宿主 `SessionManager` 监听插件的提炼请求， 在后台派生临时 `SessionContext`。
    - 组装自省 Prompt 并作为 Initial User Prompt， 实例化 Forked 子智能体。
    - **领域服务隔离**： 为自省提炼任务全新实例化并绑定专属的四大领域服务（ `RuleManager`, `ContextRepository`, `ToolDispatcher`, `CompactionService` ） 于临时的 `subContext`， 彻底斩断对主会话领域服务实例的共享与串扰， 避免了子智能体运行结束时导致主会话产生多余且无意义的磁盘 I/O。
    - 通过消费 `AgentLoop.chat()` 异步生成器循环推进自省（ 传入空的 `PluginRegistry` 防止插件递归嵌套 ）， 与主对话流的驱动机制完全对齐。

### 3. [Amend 修正] 特化写工具与依赖剥离
*   **决策**： 构造专属 `MemoryRefinementToolRegistry`， 继承自 `ToolRegistryPort`。
*   **依赖消除**： 工具注册表不依赖 `LongTermMemoryPlugin` 也不依赖 `SessionManager`， 其构造函数仅接受一个通用的代理写入函数：
    `constructor(writeMemoryFn: (content: string) => Promise<void>)`
*   **工具动作与安全标记**： 唯一注册 `writeMemoryFile` 工具。 当被大模型调用时， 执行 `await this.writeMemoryFn(args.content)` 进行追加写入， 彻底斩断了与插件或管理器的反向耦合， 维持了完美的单向依赖图。
*   **规避规范化质检**： 将该工具的 `securityCategory` 属性显式设为 `'safe'`（ 或 `'read'` ）， 确保其在执行写入时不会将子智能体宿主标记为 `hasWriteOperation = true`， 从而在 `AgentLoop` 结束自旋时跳过 `PostRunHook` 中昂贵的 `npm run lint` 和编译检查， 避免在子智能体隔离环境中产生不必要的开销与因 cwd 环境缺失导致的问题。


## 接口设计与改动点

### 1. LongTermMemoryPlugin.ts
- 构造函数签名更新：
  `constructor(driver: LlmPort, memoryFilePath?: string, onSessionEndCallback?: (history: ChatMessage[]) => void)`
- 剥离并删除 `writeQueue` 属性、 `queueWrite()` 方法以及提炼落盘相关的内部 LLM 驱动调用。
- `SessionEnd` 钩子仅负责轮数过滤判定， 判定通过后调用 `this.onSessionEndCallback(history)` 抛出事件。

### 2. session.ts ( SessionManager )
- 在构造函数注册 `LongTermMemoryPlugin` 时注入提炼回调。
- 移入并在 `SessionManager` 内部声明 `writeQueue` 与 `queueWrite(text)`。
- 动态声明 `MemoryRefinementToolRegistry` 内部类， 支持传入写入函数。
- 新增私有方法 `triggerMemoryRefinementAsync(history)` 与 `runMemoryRefinementSubAgent(history)`， 通过 `for await` 消费生成器流转。

## 风险与权衡

*   **[ 风险点 1 ] 嵌套死循环**： 若 Forked 子智能体的 `pluginRegistry` 中依然包含了 `LongTermMemoryPlugin` 本身， 将导致子智能体 SessionEnd 再次触发子子自省， 陷入无限迭代。
    *   *缓解策略*： 实例化 Forked 子智能体时， 传入空的 `PluginRegistry` 实例， 从机制上隔绝一切插件嵌套调用。
*   **[ 风险点 2 ] 自省自损运行开销**： ReAct 循环包含 1 轮大模型推理和 1 轮工具调用与确认， 相比直接调用 LLM， 多消耗 1 轮 LLM 请求的 Token。
    *   *缓解策略*： 设定严格的 `maxIterations = 3` 防爆； 且在插件层对历史对话复杂度进行了严格节流。
