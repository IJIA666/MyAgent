## 背景

当前智能助手在执行开发对话时，所有的上下文信息（如短期消息历史、局部规则等）均承载于内存中的 `SessionContext` 内。当本次会话结束或进程重启后，这些内存状态即被清空，造成跨会话经验和偏好无法保留。因此，需要引入长期记忆机制，第一阶段采用基于 Markdown 文本文件的轻量记忆系统，利用 Hook 机制实现无缝的记忆沉淀与召回。

## 目标与非目标

**目标:**
*   实现跨会话的长期记忆，在项目 `.agent/` 目录下持久化保存 `MEMORY.md`。
*   在会话结束时，异步非阻塞地提炼本次对话的关键教训与用户偏好。
*   在模型推理前，自动读取 `.agent/MEMORY.md` 并以 System Prompt 形式注入 Context。
*   保证主会话生成过程不受提炼过程的任何性能阻塞。

**非目标:**
*   第一阶段暂不引入任何物理向量数据库（如 LanceDB ）或 Embedding 模型。
*   本 Change 不引入 Sub-Agent 实例与沙箱写入隔离机制，该机制将留给第二阶段（ Change 2 ）实现。
*   不支持文件大纲解析与 PDF 等外部文档的切片 RAG 检索。

## 架构决策

### 1. 新增 `LongTermMemoryPlugin` 拦截器插件
*   **决策**：在 `src/core/usecases/` 下新建 `LongTermMemoryPlugin.ts`，继承 `Plugin` 接口并注册 to `PluginRegistry` 中。
*   **理由**：沿用项目已有的六边形架构微内核与拦截器（ AOP ）模式，通过生命周期钩子（ Hook ）将长期记忆逻辑与核心大循环（ `AgentLoop` ）彻底解耦，零侵入地修改 `llmRequest`。

### 2. SessionEnd 异步脱钩提炼
*   **决策**：在 `LongTermMemoryPlugin` 的 `HookEventName.SessionEnd` 钩子中，不使用 `await` 阻塞 `next()` 的执行。而是使用 `setTimeout` 或 `Promise.resolve().then(...)` 派生后台异步任务来调用大模型进行自省提炼。
*   **理由**：避免记忆自省提炼的额外 LLM 调用时间阻塞主循环响应，确保用户可以立刻收到 `complete` 事件。

### 3. [Amend 修正] BeforeModel 记忆召回与就地追加
*   **决策**：在 `HookEventName.BeforeModel` 钩子中，插件同步读取项目 `.agent/` 目录下 `MEMORY.md` 的内容（最大限制读取最新 4000 字符）。读取到内容后，在 `context.llmRequest.messages` 中寻找第一个 `role === 'system'` 的消息，并将其 `content` 追加修改为 `\n\n[长期记忆]\n${memoryText}`。如果未找到 system 消息，则在 `messages` 数组首部插入一个新的 system 消息。
*   **理由**：对齐已有的上下文组装机制（ `DefaultContextAdapter` ），防止由于强行重排或重复新建 system 消息导致大模型无法正确识别已拼接的 System Prompt，就地修改能保证最大的架构兼容性。

### 4. 数据与文件接口设计
*   **记忆提炼 Prompt**：提取会话历史中的 user/assistant 对话，调用 LLM（通过构造函数传入的 `LlmPort` 驱动）发送提炼指令，让 LLM 输出不超过 5 条结构化要点事实，格式为 Obsidian 要点列表。
*   **追加写入机制**：使用 Node.js 的 `fs.promises.appendFile` 异步追加写入 `.agent/MEMORY.md`。为防止并发写冲突，插件内部维护一个简单的 Promise 互斥链。

### 5. [Amend 修正] 自省提炼的节流与触发阈值
*   **决策**：在 `SessionEnd` 后台异步自省提炼任务启动前，必须检测当前 `context.sessionContext.getHistory()` 中的消息轮数是否不少于 2 轮。若对话内容过少，则直接跳过提炼，不发起大模型 API 请求。
*   **理由**：过滤掉无效的空闲轮次和极其简短的一问一答，从而大幅节省大模型的 API 消耗费用。

## 风险与权衡

*   **[ 风险点 1 ] 并发写入冲突**：如果在极短时间内触发多次 `SessionEnd`，可能导致 `.agent/MEMORY.md` 的写冲突。
    *   *缓解策略*：在插件内部使用简单的顺序队列（ FIFO Queue ），确保对 `.agent/MEMORY.md` 的追加写操作是单线程排队串行执行的。
*   **[ 风险点 2 ] System Prompt 膨胀**：随着时间推移，`MEMORY.md` 体量变大，每次注入会消耗大量 Token 甚至撑爆上下文。
    *   *缓解策略*：第一阶段在读取 Prompt 时使用 `fs` 文件字节截断或内存截取，强力限制最大读取长度为最新的 4000 字符。
*   **[ 风险点 3 ] 异步后台进程退出丢失**：在生产环境中，提炼任务通过未阻塞主进程的后台 Promise 异步运行。若提炼未完成前进程退出（例如 CLI 接收到 SIGINT 或异常退出），当次提炼结果可能会丢失。
    *   *缓解策略*：作为第一阶段轻量级方案的合理妥协。第二阶段引入隔离的 Sub-Agent 或等待队列退出保护时，由独立生命周期的子智能体或统一的进程退出等待钩子确保提炼安全落盘。
