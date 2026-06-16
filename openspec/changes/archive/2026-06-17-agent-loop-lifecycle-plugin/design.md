## 背景

智能体当前的核心推理引擎 ` AgentLoop ` ( 位于 ` [agent-loop.ts](file:///d:/Projects/MyAgent/src/brain/agent-loop.ts) ` ) 采用高度集成的串行硬编码架构。推理循环 ` chat ` 强耦合了诸如 Token 水位判断、JIT 规则注入、上下文压缩防爆、Tracer 运行日志落盘等模块，这不仅使得核心逻辑文件极难维护，也破坏了单一职责原则，阻碍了对各子模块进行隔离的单元测试与未来的拦截功能扩展。

为了解决这一问题，本设计提出将 ` AgentLoop ` 改造为基于 Hook 驱动的插件化事件注册体系。通过借鉴 ` claude-code `、` gemini-cli `、` opencode ` 和 ` hermes-agent ` 等开源项目的优秀架构，将外围策略解耦为独立的插件模块，确保核心推理引擎的精简与整洁。

## 目标与非目标

**目标:**
- **微内核生命周期化**：将 ` AgentLoop ` 的大循环执行逻辑解耦为 5 大 Hook 事件：` BeforeModel `（ LLM 发起前 ）、` AfterModel `（ 收到 LLM 响应后 ）、` BeforeTool `（ 工具调用前 ）、` AfterTool `（ 工具调用完成后 ）及 ` BeforeToolSelection `（ LLM 工具集决策过滤 ）。
- **状态沙箱安全与不可变性**：在 Hook 调用时采用类似于 ` Immer ` 的局部 ` Draft ` 修改机制，各插件对上下文（ messages 数组 ）的修改统一通过不可变（ Immutable ）状态提交，避免隐式突变和数据脏写。
- **插件异常硬隔离**：对每个挂载的插件的执行用独立的 ` try-catch ` 包裹，捕获的异常只作为 ` Warning ` 级日志记录，保障单一插件的故障绝不瘫痪主循环。
- **控制流中断与短路信号**：引入强类型的插件返回值指令（ 如 ` { action: 'abort' | 'restart' | 'continue' } ` ），在串行中间件管道中支持 Fail-Fast 机制，任一插件返回非 ` continue ` 信号时立即短路，不再执行后续插件，将信号抛回给 ` AgentLoop ` 主循环。
- **权重排序与可观测性**：基于简单的整数权重 ` weight ` 进行 Array 排序，控制插件链的执行次序，避免复杂的依赖树拓扑排序；并通过 ` produceWithPatches ` 捕获变更补丁输出到 Trace 日志，消除插件对上下文改写造成的“黑盒”隐患。

**非目标:**
- 不改变 ` AgentLoop ` 对外公开暴露的 ` chat ` 函数调用 API 签名及外部消费契约。
- 不涉及智能体底层大模型 client 驱动逻辑或工具具体 shell 执行的底层细节重写。
- 不引入多 Agent 并发通信或跨 Agent 会话调度的系统级改动（ 仅在单 Agent 状态大循环中解耦 ）。

## 架构决策

- **决策一：Hook 事件驱动的插件注册中心 ( PluginRegistry )**
  - **原因**: 采用事件订阅模式，各支撑切面（ 如 TokenWatermark, JitRules 等 ）均声明为实现了特定 Hook 接口的 Plugin 类。内核大循环在各关键行仅负责触发对应的 ` fireHook `。这使 ` AgentLoop ` 的代码规模有望减少 60% 以上，职责极其单一。

- **决策二：基于洋葱模型 ( Onion Model ) 的异步不可变管道传递**
  - **原因**: 许多 Hook 包含异步操作（ 如拉取文件 JIT 规则 ），而在异步流程中持有长期的局部 Draft 容易因状态陈旧而产生 Bug。为此，设计采用洋葱模型，在进入 Hook 链前克隆上下文，并在全链 resolve 之后利用 ` produceWithPatches ` 产出最终合并后的不可变状态。这既规避了并发污染，又能获取每次变更生成的 Patches 补丁包，为系统调试提供完美的可追溯 Trace。

- **决策三：串行管道短路（ Fail-Fast ）控制流**
  - **原因**: 引入串行洋葱模型后，任何一个 Hook 插件在被调用时，如若返回非 ` continue ` 控制流信号（ 如 ` abort ` 强行终止或 ` restart ` 压缩重启 ），执行管道必须立即短路，跳过后续所有插件，将该信号直接返回给 ` AgentLoop `，这完全避免了 Immer 并发修改 Draft 合并的逻辑死锁，更易维护。

- **决策四：提示词缓存友好前缀注入策略**
  - **原因**: 插件（ 如 JIT 规则注入 ）如果频繁在 ` system prompt ` 前缀中拼接数据，会导致大模型的 Prompt Cache 缓存失效，带来显著的首 token 延迟及费用暴增。决策规定，所有上下文注入类 Hook 仅允许将数据 append 追加在对话历史的最近一条 ` user ` 消息尾部，确保 ` system ` 头在大模型推理中保持 100% 缓存一致性。

## 风险与权衡

- **[ 风险点 ]**：异步插件执行时，因上下文被并发改写导致状态脏写或 Draft 失效。
  - **[ 缓解策略 ]**：建立链式洋葱中间件，每个异步 Hook 必须使用完全独立并隔离克隆的子 Draft，且 Hook 执行采用严格串行执行，不允许并发访问或修改同一上下文。
- **[ 风险点 ]**：引入 Hook 系统与 Patch 可观测性导致首 token 推理响应耗时（ Latency ）增加。
  - **[ 缓解策略 ]**：非上下文修改类的插件（ 如日志 Trace、监控 ）一律采用异步不阻塞（ Non-blocking ）背景线程执行；对修改类插件做严格的本地执行耗时统计，如耗时超标则记录 Warning。
- **[ 风险点 ]**：多插件执行顺序不当导致逻辑混乱（ 如 Token 水位计算在 JIT 注入之前运行 ）。
  - **[ 缓解策略 ]**：为插件引入整数权重 ` weight ` 机制（ 如 ` JitRulesPlugin ` 权重设为 10，` TokenWatermarkPlugin ` 设为 20 ），在主循环初始化时使用原生 ` sort ` 按权重升序执行，简单明了，杜绝过度工程。
