# 探索主题: 后台自省子智能体无超时挂起与驱动竞态隐患深度剖析

## 1. 问题定义
在 `my-simple-agent` 项目的长期记忆模块中，[MemoryService.ts](file:///d:/projects/MyAgent/src/core/usecases/MemoryService.ts) 后台子智能体在会话结束时负责异步运行并自省提取 `MEMORY.md`。但由于以下两个架构层面的设计遗漏，存在后台卡死死锁造成句柄泄露，以及并发调用覆写造成 API 取消控制冲突的严重架构缺陷：
1. **死锁无超时强杀**：后台子 Agent 运行在独立的 `AgentLoop` 微任务循环中，其 `for await` 异步迭代流式输出由于缺少超时阈值（Timeout）与外置 `AbortSignal` 控制。一旦 LLM 网络卡死或在途连接挂起，子 Agent 将无限期常驻占用 TCP 句柄，从而在长时间运行中累积发生句柄与套接字泄露。
2. **驱动实例单例竞态与取消漏拦截**：派生的后台 `forkedAgent` 共享了注入的同一个 `LlmPort`（即 `OpenAiLlmAdapter` 单例）。由于适配器采用全局 `this.abortController` 单例设计，每次流式调用 `streamChat` 均会强行覆写该实例。一旦主流程与自省流程并发运行，极易发生竞态覆写并引发跨会话误杀。同时，该全局设计也漏掉了对非流式 `chat()` 方法的在途请求取消支持，导致调用 `abort()` 时无法物理掐断正在进行的 `chat()` 请求。

## 2. 关键发现与调研结果
- **代码库现状**：
  1. [LlmPort.ts](file:///d:/projects/MyAgent/src/ports/driven/LlmPort.ts) 的方法签名（`streamChat`, `chat`）不支持由上层业务级传入独立的 `AbortSignal` 句柄，阻碍了隔离式取消机制的设计。
  2. [OpenAiLlmAdapter.ts L132](file:///d:/projects/MyAgent/src/adapters/llm/OpenAiLlmAdapter.ts#L132) 内部没有做到请求级 AbortController 的生命周期隔离。
  3. [OpenAiLlmAdapter.ts L114](file:///d:/projects/MyAgent/src/adapters/llm/OpenAiLlmAdapter.ts#L114) 的 `abort()` 方法只清理全局单例，未能与并发执行的多个流式及非流式请求绑定，导致非流式 `chat()` 无法被中途取消。
  4. [MemoryService.ts L285-L288](file:///d:/projects/MyAgent/src/core/usecases/MemoryService.ts#L285-L288) 采用 `for await` 循环获取子 Agent 生成且未挂载超时保护。
- **核实与洞察**：
  1. 在现代 Node.js/TypeScript 环境下，对在途 HTTP 请求或 LLM API 进行时间限制取消的标准最佳实践是使用 `AbortSignal.timeout(ms)` 或其对应的 `AbortController` 取消控制权，在超时触发后直接下沉传递至底层网络请求库，直接强杀终止连接并释放 TCP Socket 句柄。
  2. 部分优秀项目（如 `hermes-agent`）会在调用后台子任务时注入外置的取消和中断接口，从而支持级联式中断和强杀，不遗留卡死的僵尸协程。

## 3. 方案对比与推荐方向

| 评估维度 | 方案 A (仅在 Generator 消费端 Promise.race 拦截) | 方案 B (推荐：重构 LlmPort 注入 AbortSignal 进行级联控制) |
| :--- | :--- | :--- |
| **物理连接释放** | ✗ 无法释放连接。虽消费端被赛车逻辑拦截退出，但底层的在途 HTTP 生成请求在后台依然会被大模型服务器传输直至完毕，泄露无法根治。 | ✓ 彻底释放。通过将 `AbortSignal` 传递给底层 HTTP client/fetch，触发立即强杀，物理关闭 TCP 连接并彻底释放资源。 |
| **并发/取消隔离性** | ✗ 极低。无法防范并发状态下对全局 `abortController` 单例的覆写竞态，各租户或子线程生成交互可能相互干扰。 | ✓ 极高。每个独立的生成任务均能够传入专用的 `AbortSignal`（如 `AbortSignal.timeout`），适配器将隔离使用各调用的 signal，互不干扰。 |
| **重构代价** | ✓ 极低。仅需在 `MemoryService` 内部进行消费端包装。 | ⚠️ 中等。需要修改驱动 Port 接口签名和适配器层的具体逻辑。 |

**推荐路径**：采用**方案 B**。通过升级 Hexagonal 接口定义，在 `streamChat` 和 `chat` 调用中传入独立的 `AbortSignal`，并对 `OpenAiLlmAdapter` 进行请求级多实例重构，彻底解决并发竞态与取消漏拦截问题。

## 4. 约束、风险与未知项
- **多实例局部 Abort 兼容设计**：为根除竞态，必须废除 `OpenAiLlmAdapter` 的全局 `this.abortController` 单例。每次 `streamChat` 或 `chat` 调用时，内部均动态创建一个局部 `localAC: AbortController`。若上层传入了 `options?.signal`，则通过 `AbortSignal.any([localAC.signal, options?.signal])` 组合级联。适配器内部需要维护一个活跃请求控制器的集合（Set 结构），在调用 `abort()` 方法时，向当前所有在途活跃的局部控制器发送 abort 信号，以此兼容原先 the `abort()` 控制并实现无竞态的多实例隔离。
- **超时控制颗粒度（单次调用超时 vs 整体超时）**：自省子智能体涉及最多 3 轮 ReAct 迭代。如果在 `MemoryService` 外围的 `for await` 对自省过程套总超时，单次响应慢就会耗尽总时间，导致后续迭代完全没有机会执行。正确的超时机制应是在每次底层 `streamChat` 或 `chat` 发起时（由 `AgentLoop` 驱动），注入单次调用超时信号 `AbortSignal.timeout(perCallMs)`，从而保障多轮交互的整体健壮性。

## 5. 否决方案
- **使用 `process.kill()` 等粗暴子进程终止**：子智能体运行在 Node 的同一个事件循环中，没有派生单独的 Node 子进程，无法通过进程级信号杀死，因此必须依赖语言级的 Abort 机制。
