## 改造原因

在大模型（尤其是 DeepSeek API）的多轮 ReAct 交互过程中，为了动态加载特定项目规则和临时技能，当前的上下文装配适配器采用在最后一条 `user` 消息前强行插入独立的 `system` 消息的设计。当对话多轮推进时，上一轮插入的 `system` 节点在历史消息队列中的相对位置不断变化（每次都移动到最新 `user` 消息之前），这破坏了消息时序，并且会导致大模型服务端的 Prompt Caching 前缀缓存频繁失效。高频的缓存击穿造成了巨大的 Token 计费开销，并且严重增加了接口的首字延迟（TTFT）。

为了降低大模型 API 交互成本，缩短多轮响应延时，我们有必要对上下文消息流组装与注入机制进行深度优化，在不破坏历史前缀哈希一致性的前提下，实现对局部规则和临时技能的安全热加载。

## 变更内容

1. **内嵌 XML 指令拼接**：重构 `DefaultContextAdapter`，停止在 `lastUserIndex` 之前插拔独立 `system` 消息的行为。取而代之的是，将局部规则（`<project_rules>`）和临时技能（`<transient_skill>`）通过特定 XML 标签包装，直接拼接在最新一条 `user` 消息的 `content` 尾部，并作为历史不可变消息进行物理持久化，实现 100% 的前缀缓存前瞻锁定。
2. **呈现层 XML 标签组件化渲染**：在向终端 TUI 呈现、日志记录等视觉层展示时，底座（Harness）将解析历史消息中的 XML 定界符，并将其转换为可交互折叠的精美 inline 标签或卡片微件，折叠隐藏复杂的技能与规则全文。在保持排版紧凑性的同时，保留用户的上下文知情权。
3. **高水位物理压缩兜底**：维持超长会话时的 `compact()` 水位防护机制，当单 Session 估算 Token 超出安全上限（如最大窗口的 75%）时，通过同步调用总结模型提炼摘要并轮换新 Session，防范历史不剪枝引发的 Token 窗口失控。

## 业务能力

### 新增业务能力
- 无

### 修改业务能力
- `rules-injection-caching`: 优化局部规则与临时技能的注入通路，由 system 插拔调整为 user 尾部 XML 内嵌，利用消息时序递增锁定前缀缓存。
- `context-adapter`: 重构消息适配器的组装拼装细节，停止中间插拔消息，并提供在终端 TUI 展现层的 XML 标签微件折叠解析能力。

## 影响范围

- **核心代码**：[DefaultContextAdapter.ts](file:///D:/projects/MyAgent/src/brain/adapters/DefaultContextAdapter.ts) 的消息组装拼装函数。
- **会话管理**：[SessionManager.ts](file:///D:/projects/MyAgent/src/brain/session.ts) 的消息历史提炼、UI 状态事件吐出以及日志落盘逻辑。
- **测试用例**：需更新对应的 Adapter 组装单元测试与集成测试，覆盖内嵌拼接和缓存命中场景。
