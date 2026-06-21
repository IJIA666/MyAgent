## 改造原因

在第一阶段中， 长期记忆提炼是通过在 `SessionEnd` 生命周期钩子中直接异步调用 LLM 接口， 并硬编码追加写入 `.agent/MEMORY.md` 来实现的。 这种实现方式虽然轻量， 但存在一个潜在的安全设计隐患：
自省提炼任务完全运行在主智能体的同一个执行上下文中。 如果用户的对话历史中包含恶意的 Prompt 注入攻击（ Prompt Injection ）， LLM 在阅读并提炼这些历史时， 可能会被操纵去执行意料之外的越权写操作， 甚至恶意篡改其它与记忆无关的文件。

为了彻底消除这一越权隐患， 我们在第二阶段引入**子智能体沙箱隔离机制（ Forked Sub-Agent Sandboxing ）**。
同时， 为了规避依赖倒置（ 插件层 LongTermMemoryPlugin 无法也没有权限直接实例化和驱动包含了 8 大依赖的 `AgentLoop` 核心引擎 ）， 我们采用**事件/回调派发 + SessionManager 托管 Fork 机制**。 插件层仅负责生命周期拦截与过滤， 将自省历史数据通过回调向上派发； 由宿主协调层 `SessionManager` 监听并拉起隔离的 Forked Agent 实例以执行具体的 ReAct 自省与安全写入。

## 变更内容

1. **事件与回调式解耦**： `LongTermMemoryPlugin` 插件作为轻量拦截器， 仅在 `SessionEnd` 节点负责对话轮数判定， 若满足自省阈值， 则通过构造函数注入的回调机制将对话历史抛出， 插件自身与 `AgentLoop` 执行引擎解耦。
2. **Session 协调层托管 Fork**： 宿主类 `SessionManager` 将监听插件的提炼请求， 全新实例化子智能体专属的隔离领域服务（如 `ContextRepository`）， 并从底层拉起沙箱隔离的子智能体。
3. **隔离的 Forked Agent 实例**： 为自省提炼任务构造一个拥有干净临时上下文且搭载极简工具注册表（ `MemoryRefinementToolRegistry` ） 的子 `AgentLoop` 实例， 通过完全隔离的四大领域服务解耦主会话的读写， 并强制设置运行步数防爆。
4. **特化只读/写工具注入**： 为子智能体专属注入 `writeMemoryFile` 工具， 路径锁死在 `.agent/MEMORY.md`， 且该工具的 `securityCategory` 设为 `'safe'` 以跳过子智能体执行写盘操作后的 PostRunHook 全量 Lint 与编译检查， 规避不必要的开销与环境缺失异常。
5. **异步消费推理生成器**： 通过 `for await` 消费 `AgentLoop.chat()` 异步生成器推进子智能体 ReAct 运转， 自省并安全落盘。

## 业务能力

### 新增业务能力
- `forked-subagent-memory-refinement`: 在会话结束后， 派生一个受限的 Forked Agent 实例， 通过受限的写工具安全提炼并追加写入长期记忆， 防范 Prompt 注入越权。

## 影响范围

*   **LongTermMemoryPlugin 插件**： 重构构造函数， 接受提炼自省回调； 插件内的 `refineAndAppendMemory` 变为调用该回调， 不再直接负责 LLM 接口调用和文件物理读写。
*   **SessionManager 类**： 接受插件的自省回调， 负责异步实例化并驱动 Forked 子智能体 ReAct 运行； 负责声明 `MemoryRefinementToolRegistry` 特化只读/写工具。
*   **安全机制**： 提升了提炼自省任务的整体隔离防护评级， 降低了任意命令执行（ RCE ） 及任意文件篡改的风险。
