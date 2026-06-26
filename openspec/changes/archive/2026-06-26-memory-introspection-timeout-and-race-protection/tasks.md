## 1. 契约签名与底层适配器改造

- [x] 1.1 修改 [LlmPort.ts](file:///d:/projects/MyAgent/src/ports/driven/LlmPort.ts)，定义 `LlmPortOptions` 并扩展 `chat` 和 `streamChat` 方法签名。

- [x] 1.2 重构 [OpenAiLlmAdapter.ts](file:///d:/projects/MyAgent/src/adapters/llm/OpenAiLlmAdapter.ts)，废除全局单例 `abortController`，引入 `activeControllers` 集合以存储和管理局部在途请求控制器。

- [x] 1.3 实现 [OpenAiLlmAdapter.ts](file:///d:/projects/MyAgent/src/adapters/llm/OpenAiLlmAdapter.ts) 对局部取消与外部 options 信号的级联绑定。如果支持 `AbortSignal.any`（Node.js 20+ 原生）则直接使用；否则手动订阅外部信号的 `abort` 事件并触发局部控制器取消，并在 `finally` 块中调用 `removeEventListener` 移除监听，确保不同 Node.js 版本下均能物理掐断流式与非流式网络请求，且不引起内存泄露。

- [x] 1.4 重写 [OpenAiLlmAdapter.ts](file:///d:/projects/MyAgent/src/adapters/llm/OpenAiLlmAdapter.ts) 中的 `abort()` 方法，使其向所有活跃的局部控制器发送 abort 广播，确保向后兼容性。

<!-- checkpoint: npx tsc --noEmit -->

## 2. 推理循环与长期记忆调用改造

- [x] 2.1 修改 [agent-loop.ts](file:///d:/projects/MyAgent/src/core/usecases/agent-loop.ts)，使 `AgentLoop.chat` 接收外部传入的可选 `options?.signal` 信号。在每次发起流式 `streamChat` 前，内部通过 `AbortSignal.timeout(ms)` 动态生成调用级单次超时信号，并将其与外部 `signal` 通过级联方式（如 `AbortSignal.any` 或等效逻辑）组合透传，杜绝底层挂起。

- [x] 2.2 重构 [MemoryService.ts](file:///d:/projects/MyAgent/src/core/usecases/MemoryService.ts)，在 `runMemoryRefinementSubAgent` 派生自省子智能体时，配置会话级（60 秒总超时）的 Abort 信号并作为 options 透传给子智能体的 `forkedAgent.chat`。

- [x] 2.3 补充对自省子智能体由于超时挂起引发的取消异常进行捕获 and 优雅静默日志记录，以保障自省子进程崩溃时不会波及主交互流程。

<!-- checkpoint: npx tsc --noEmit -->

## 3. 测试套件扩充与全量验证

- [x] 3.1 在 `test/brain/adapters/` 目录下编写/扩展针对 `OpenAiLlmAdapter` 局部并发隔离、级联取消与全局 `abort()` 广播的测试；同时在 `test/session/MemoryService.test.ts` 中编写自省超时强杀与静默降级的测试用例。

- [x] 3.2 运行全量单元测试与 lint 静态扫描，验证并发物理连接断开及自省防卡死机制的可靠性，确保修改无任何功能性与稳定性负面效应。

<!-- checkpoint: npm test && npm run lint -->
