## 背景

在项目长期记忆模块的后台自省机制中，子智能体异步执行多轮迭代用于生成记忆，但由于缺乏超时机制和外部 `AbortSignal` 控制，一旦遭遇网络卡死或在途请求挂起，该后台自省流程将无限期挂起并持续占用 TCP 句柄，从而造成严重的系统句柄和套接字泄露。

此外，派生的后台自省流程与前台主流程共享同一个 `LlmPort`（即 `OpenAiLlmAdapter` 单例）。由于适配器采用全局 `this.abortController` 单例，导致在并发调用流式 `streamChat` 时发生竞态覆写，甚至引发跨会话误杀。同时，该全局设计也漏掉了对非流式 `chat()` 方法的在途请求取消支持，导致调用 `abort()` 时无法物理掐断正在进行的 `chat()` 请求。

## 目标与非目标

**目标:**

- 实现局部 `AbortSignal` 级联式取消控制，废除 LLM 适配器中的全局 `this.abortController` 覆写。

- 实现非流式 `chat` 方法的在途物理取消，通过将 `AbortSignal` 传递至底层的 OpenAI SDK 客户端。

- 在并发情况下实现请求级取消隔离，且向后兼容原先的全局 `abort()` 触发机制，使用 Set 集合广播取消信号。

- 实现对自省子智能体每次 LLM 请求的超时控制（`AbortSignal.timeout`），杜绝因请求挂起引发的句柄与套接字泄露。

**非目标:**

- 不改变 LLM 适配器的外部依赖和底层网络请求库，继续使用官方的 `openai` 客户端。

- 不引入系统进程级的 `kill` 中断，仅使用 Node.js 语言原生的 `AbortController`/`AbortSignal` 取消机制。

- 不修改自省本身的记忆提取逻辑，仅优化其在途超时和并发控制。

## 架构决策

- **决策一：废除全局单例控制器，改用活跃局部控制器集合（Set）**
  - **背景**：传统的全局 `this.abortController` 只能跟踪最后一次发起的请求，在并发环境下会导致前一次请求的控制器被覆写而失去控制。改用局部 `localAC: AbortController` 并维护一个 `activeControllers: Set<AbortController>`，可以实现请求级别的隔离。
  - **实现细节**：在 `OpenAiLlmAdapter` 类中定义 `private activeControllers = new Set<AbortController>()`。在每次调用生成方法开始前，生成局部的 `localAC` 并存入集合；在请求结束（包括成功、抛出异常或被取消）的 `finally` 块中，将该 `localAC` 从集合中移除并销毁，避免内存泄漏。
  - **取消广播**：原有的 `abort()` 方法继续保留作为向后兼容接口，但其实现在内部遍历该 Set 集合，依次调用每个活跃控制器的 `abort()` 方法，从而兼容一键取消全部在途请求的场景。

- **决策二：级联信号组合与兼容性设计**
  - **背景**：如果上层调用方传入了局部的 `options?.signal`，我们需要在适配器内部同时响应外部的取消信号和内部的局部控制器取消信号（或超时信号）。
  - **实现细节**：在 Node.js 中，通过 `AbortSignal.any([localAC.signal, options.signal])` 组合多个信号，可以生成一个统一的级联信号传递给下层的 OpenAI SDK 客户端。为了兼容低于 Node.js v20.0.0 的环境（不支持 `AbortSignal.any`），我们将实现一个兼容层：若原生不支持 `AbortSignal.any`，则通过手动订阅外部 `signal` 的 `abort` 事件来通知局部控制器。

- **决策三：单次调用级超时控制注入**
  - **背景**：自省子智能体的最大 ReAct 轮次为 3 轮。若采用全局总超时，网络延迟等波动极易在早期就把总时间消耗完毕，导致后续迭代直接失败。
  - **实现细节**：在 `AgentLoop` 驱动每次底层生成请求时，传入 `AbortSignal.timeout(perCallMs)`，可以让单次响应超时时安全报错退出，并通过循环机制或者由 `MemoryService` 捕获异常进行优雅降级，保障多轮交互的整体健壮性。

## 风险与权衡

- **物理取消引发的异常处理**
  - **风险**：底层物理连接断开时，OpenAI SDK 会抛出 `AbortError` 或 `APIConnectionError`。如果上层未做妥善捕获，会导致异常冒泡至系统顶层，造成整个 Node.js 进程崩溃。
  - **缓解策略**：在 `AgentLoop` 和 `MemoryService` 的调用外围，必须使用 `try-catch` 显式捕获取消引发的异常。对于被取消或超时的操作，做静默处理或转换为预期的“超时/取消”降级状态，避免破坏整个生命周期。

- **`AbortSignal.any` 监听器的垃圾回收**
  - **风险**：如果手动实现低版本 `AbortSignal.any` 的兼容方案，在监听外部信号时如果未在请求结束时移除对应的 `abort` 监听器，会导致内存泄漏。
  - **缓解策略**：在兼容逻辑中，确保在 `finally` 块中通过 `signal.removeEventListener` 移除所有的事件订阅。
