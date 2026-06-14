## 背景

MyAgent 当前的 `readFile` 实现每次都会通过系统 API 获取文件的全量内容并原样作为 `tool_result` 返回给大模型。在涉及长代码文件修改的多轮对话中，大模型倾向于反复调用 `readFile` 来验证和确认上下文，这会导致同一份物理文件在对话历史 (Context) 中产生多个完整副本，进而造成前缀缓存（Prompt Caching）的破坏以及 Token 开销的线性膨胀。

## 目标与非目标

**目标:**
- 拦截未发生物理变化的文件读取请求，返回简短的去重占位符 (Stub)。
- 最大化利用前沿大模型的 Prompt Caching 机制，避免同一内容重复消耗昂贵的 Cache Creation 费用。
- 保证 100% 兼容大模型原生的 Tool Call / Message 数据结构协议。

**非目标:**
- 暂不修改全局的 Session 或 ContextAdapter 层的生命周期以及组装逻辑。
- 不引入跨进程级别的复杂读写锁。本变更仅限于单次进程中读取操作上下文体积的无损压缩去重。

## 架构决策

**基于 mtime 的运行时拦截指针：**
在 `readFileTool` 中引入一个伴随运行时生命周期的内存字典 `readFileState`，记录每个文件的读取快照，其结构可简化为 `[filePath]: { offset, limit, timestamp }`。
在每次执行 `readFile` 时，首先获取目标文件的 `mtimeMs`（修改时间戳）：
1. 若缓存字典中存在该路径，且本次读取的 `offset` 和 `limit` 范围与上次一致，同时磁盘上的 `mtimeMs` 等于缓存中的 `timestamp`，则直接中止真实的物理读取。
2. 工具强制返回 Stub 占位符：`"File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading."`。
*备选方案被否的原因*：曾考虑通过“状态化文件挂载”将文件统一抽取到 System Prompt 头部。但这需要深度修改底层的消息序列化截断协议，极易引起其他兼容性问题。而 Stub 方案完全不改变底层通信链路，且已被业界标杆验证。

## 风险与权衡

- **模型认知偏差风险：** 部分早期或参数较小的开源模型可能会因为看不到明文而产生幻觉。
  - *缓解策略*：目前默认对接的均为第一梯队前沿模型（如 GPT-4o, Claude 3.5, Gemini 1.5），其“大海捞针”能力已获业界公认，且官方（Claude Code）自身也深度依赖此机制，因此在当前生态下风险极低。
- **缓存一致性问题：**
  - *缓解策略*：只有当物理磁盘上的 `mtimeMs` 完全一致时才触发拦截。如果被本地其他进程或其它工具（如写文件工具）修改，`mtimeMs` 必然改变，下次 Read 会直接 Cache Miss 从而强制重新读取，天然免疫了脏读风险。
