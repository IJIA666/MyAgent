- **SessionManager**：这是会话管理的控制中枢，它负责插件的生命周期和洋葱模型的构建。
- **TypeScript**：这是项目的核心开发语言，所有的插件和驱动都必须使用 TypeScript 编写。


- **主要技术栈**：项目使用 **TypeScript** 作为主要开发语言，基于 Node.js 运行时，搭配 vitest 测试框架与 ESLint 代码检查工具，属于标准的 TypeScript 全栈/库项目结构。

- **MCP 协议集成**：项目中存在 `mcp_config.json` 和 `mcp_config.example.json` 配置文件，表明该项目集成了 Model Context Protocol（MCP）协议，需关注后续 MCP 相关配置与工具链的维护。

- **混合语言组件**：项目根目录包含 `.venv`（Python 虚拟环境）和 `monitoring_server` 目录，提示该项目除了 TypeScript 主模块外，还依赖 Python 编写的监控或辅助服务组件。

- **开发规范约束**：项目携带了《阿里开发规范（黄山版）.md》文档，说明团队以阿里前端/Node.js 开发规范作为编码标准，代码风格和命名规则需对齐该规范。


**项目技术栈**：该项目名为 my-simple-agent，使用 TypeScript 编写，主要依赖包括 OpenAI SDK、Immer（不可变状态管理）、MCP SDK、Playwright 等，测试框架使用 Vitest，作者为 wangjia。

**SessionManager 位置**：SessionManager 是核心会话管理模块，位于 src/core/usecases/session.ts，被 CLI 界面层和命令模块广泛引用，在 test/session/SessionManager.test.ts 中有完整的单元测试覆盖。

**项目结构特征**：项目采用分层架构，包含 core/usecases（核心用例层）、adapters/input/interface（适配器/输入界面层）等目录结构，src 目录为源码主目录，test 目录存放测试。


- **项目语言与技术栈**：项目 `my-simple-agent` 使用 **TypeScript** 编写（模块类型为 ESM），运行于 Node.js 环境，核心依赖包括 OpenAI SDK、immer（状态管理）、Playwright（浏览器自动化）和 @clack/prompts（CLI 交互）。

- **SessionManager 所在层**：SessionManager 定义在 `src/core/usecases/session.ts` 中，属于核心用例层，被 CLI 接口层（`src/adapters/input/interface/cli.ts`）和命令层（`src/adapters/input/interface/commands/base.ts`）导入调用。

- **SessionManager 架构设计**：SessionManager 继承自 EventEmitter，聚合了 AgentTracer、SessionContext、ContextAdapter、ToolRegistryPort、AgentLoop、ChatUseCase、TaskAborterPort 和 PluginRegistry 等多个核心组件，负责统一的会话生命周期管理。




- **AgentTracer 组件定义**：AgentTracer 定义在 `src/core/domain/tracer.ts`，属于领域层核心类。

- **use cases 层消费**：AgentTracer 在 `src/core/usecases/` 下被三个文件引用——`agent-loop.ts`（作为参数注入）、`session.ts`（私有字段，多处实例化）、`TracerLogPlugin.ts`（通过 provider 函数注入）。

- **测试覆盖参考**：测试文件 `test/brain/plugins.test.ts` 中 mock 了 AgentTracer 实例，可作为编写单元测试时的参考模式。


- **AgentTracer 定义位置**：AgentTracer 类定义在 `src/core/domain/tracer.ts:53`，属于领域层（domain）实体。

- **SessionManager 持有 Tracer**：`SessionManager`（`session.ts`）是 `AgentTracer` 的唯一创建者和生命周期管理者，在构造/重置/子会话三个路径中分别实例化，并向下游传递。

- **两种注入模式**：下游消费者通过两种方式获得 `AgentTracer`：一是构造函数依赖注入（`agent-loop.ts`），二是闭包 provider 函数注入（`TracerLogPlugin.ts`，以 `() => AgentTracer` 形式）。

- **TracerLogPlugin 桥接设计**：`TracerLogPlugin` 并未直接持有 `AgentTracer` 实例，而是通过 `tracerProvider` 回调函数在运行时按需获取，实现了插件与 tracer 的解耦。


- **AgentTracer 定义**：组件定义在 `src/core/domain/tracer.ts`，属于领域层核心类。
- **AgentTracer 使用**：在 `src/core/usecases/session.ts`、`agent-loop.ts` 和 `TracerLogPlugin.ts` 三个 usecase 模块中被导入并实际注入/实例化。
- **AgentTracer 实例化**：在 `session.ts` 中基于 `baseDir` 和 `sessionId` 创建实例，并支持通过子目录创建子 tracer（subTracer），表明该组件具备分层追踪能力。


- **AgentTracer 定义**：追踪器核心类定义于 `src/core/domain/tracer.ts:53`，属于领域层组件。

- **三大消费者**：`src/core/usecases/session.ts`（直接持有字段并多次 `new` 实例化）、`src/core/usecases/agent-loop.ts`（通过参数注入）、`src/core/usecases/TracerLogPlugin.ts`（通过 provider 回调延迟获取）。

- **依赖注入架构**：AgentTracer 的使用遵循依赖注入与解耦设计，session 管理生命周期，agent-loop 接收参数，TracerLogPlugin 通过回调解耦获取 tracer。

- **测试 mock 引用**：`test/brain/plugins.test.ts` 通过 `as unknown as AgentTracer` 进行类型 mock 测试。


- **AgentTracer 组件**：定义于 `src/core/domain/tracer.ts`，通过 JSONL 格式将交互日志追加写入磁盘 `{workspaceDir}/.myagent/traces/trace_{sessionId}.jsonl`，使用 `appendFileSync` 实现同步追加写入。设计上采用依赖注入模式 —— `agent-loop.ts` 通过参数注入、`session.ts` 通过字段持有并管理生命周期、`TracerLogPlugin` 通过 provider 回调函数 (`() => AgentTracer`) 延迟获取。

- **Tracer 容错原则**：`logInteraction` 与 `logPluginAudit` 中的写入失败均被 `try/catch` 捕获并仅打印 `console.error`，绝不抛出异常阻断核心会话流。这是一个明确的非致命组件设计决策。

- **插件解耦模式**：`TracerLogPlugin` 不直接持有 `AgentTracer` 实例，而是通过构造函数接收 `tracerProvider: () => AgentTracer` 回调。这种方式避免了插件与具体 tracer 实例的紧耦合，也规避了 session 与插件之间的循环依赖问题。

- **并发写入现状**：当前使用同步 `appendFileSync` 且未使用文件锁机制。但由于每个 session 实例通过 `sessionId` 生成独立文件名（`trace_{sessionId}.jsonl`），不同 session 间天然不会竞争同一文件；同一 session 内由于单线程的 Node.js 事件循环模型，同步 I/O 亦不存在竞争。现有设计足以覆盖当前的使用场景。

- **Immer Patches 上下文审计**：`TracerLogPlugin` 在每个生命周期 Hook 的前后调用 `auditCurrentPatches`，通过 `context.sessionContext.getAndClearPluginPatches()` 获取并记录 Immer 产生的属性修改快照，实现了细粒度的上下文变更审计。


- **AgentTracer 组件架构**：`AgentTracer` 定义在 `src/core/domain/tracer.ts`，通过依赖注入被 `agent-loop.ts`（参数注入）、`session.ts`（字段持有 + 多次 `new` 实例化）和 `TracerLogPlugin.ts`（provider 回调解耦）三方消费，遵循解耦设计思路。

- **并发写入安全策略**：`AgentTracer` 不使用显式锁（mutex/semaphore），而是通过 **session 隔离**（每个 session 写独立文件 `trace_{sessionId}.jsonl`）+ **同步原子写入**（`appendFileSync`）+ try-catch 容错来保证写入安全，天然避免同文件多线程竞争。

- **queueWrite 写入队列**：`session.ts`（L457）存在 `queueWrite` 私有方法，作为文本内容的异步写入队列机制，用于 MEMORY.md 等共享文件的串行化写入控制。

- **文件锁容错测试模式**：`test/scripts/setup_testbed.ts` 通过 PowerShell 创建 `locked_app_runtime.log` 的独占文件锁（`FileShare.None`），模拟文件被外部进程锁定时的异常场景，用于验证系统在文件 I/O 受阻时的容错与优雅降级能力。


- **AgentTracer 架构设计**：AgentTracer 定义在 `src/core/domain/tracer.ts`，通过三种方式被消费——`agent-loop.ts` 参数注入、`session.ts` 字段持有并管理生命周期（多次 `new` 实例化）、`TracerLogPlugin.ts` 通过 provider 回调函数延迟获取，整体遵循依赖注入与解耦设计。

- **并发写入安全策略**：框架采用两层策略——1) `AgentTracer` 使用 `appendFileSync` 同步写入，单进程内天然安全但无多进程保护；2) `session.ts` 的 `queueWrite` 方法基于 Promise 链式串联（`this.writeQueue = this.writeQueue.then(...)`）实现互斥队列，确保异步追加写入不交叉污染。未使用系统级互斥锁或信号量。

- **Tracer 容错设计**：`logInteraction` 与 `logPluginAudit` 均包裹 try-catch，错误仅打印 `console.error` 日志，绝不阻断核心会话流。


- **AgentTracer 定义**：`AgentTracer` 定义在 `src/core/domain/tracer.ts`，通过 `appendFileSync` 向 `.myagent/traces/trace_{sessionId}.jsonl` 写入 JSONL 格式的交互日志，确保单进程内写入安全。

- **Trace 文件不设锁**：`AgentTracer` 的日志写入完全依赖 Node.js 单线程事件循环 + `appendFileSync` 原子追加，**未使用**文件锁、互斥量或写入队列，对同一 trace 文件的并发写入仅在同一进程的单线程模型下保证安全。

- **Memory 文件写队列**：`SessionManager` 的 `queueWrite()` 通过 Promise 链式队列（`this.writeQueue = this.writeQueue.then(...)`）串行化所有对 `.agent/MEMORY.md` 的追加写入，在此操作后还会自动触发 `syncNewMemoryToVectorDb()` 向量库同步。

- **TracerLogPlugin 审计机制**：`TracerLogPlugin` 通过 `tracerProvider()` 回调延迟获取 tracer 实例，挂载在 6 个生命周期 Hook（SessionStart/End、Before/After Model、Before/After Tool）上，利用 `getAndClearPluginPatches()` 捕获 Immer 产生的上下文变更补丁并写入独立的 `plugin_audit_trace_{sessionId}.jsonl` 文件。


- **AgentTracer 架构地位**：AgentTracer 定义在 `src/core/domain/tracer.ts`，是领域层核心追踪组件，被 `session.ts`（直接持有并多次实例化）、`agent-loop.ts`（参数注入）、`TracerLogPlugin.ts`（Provider 回调注入）三个 use case 文件消费，设计上遵循依赖注入与解耦原则。

- **并发写入双轨策略**：框架对 Tracer 采用 "同步写入 + 天然无竞争" 方案（用 `appendFileSync` 且按 sessionId 分文件隔离），对长期记忆 MEMORY.md 则使用 Promise 链式互斥队列做显式串行化保障，两套策略差异化应对不同的并发风险等级。

- **AgentTracer 故障隔离设计**：`logInteraction` 和 `logPluginAudit` 中所有磁盘写入失败均被 `try/catch` 捕获并仅打 `console.error`，绝不会抛出未捕获异常或阻断核心会话流，这是明确的设计决策。

- **Session 互斥写入队列模式**：`session.ts` 中 `queueWrite` 方法使用经典的 Promise-chain 模式（`this.writeQueue = this.writeQueue.then(...)`）实现异步写入操作的串行化，即使 `triggerMemoryRefinementAsync` 等方法并发调用，写入也会按调用顺序依次执行，不会互相覆盖或交叉损坏文件。

- **TracerLogPlugin 解耦模式**：该插件通过构造函数注入 `tracerProvider: () => AgentTracer` 回调函数而非直接持有 tracer 实例，实现插件与追踪仪的延迟绑定和解耦，所有生命周期 Hook 串行通过 `await next()` 执行，无需额外的锁机制。


- **AgentTracer 分层注入架构**：`AgentTracer` 定义在领域层 `src/core/domain/tracer.ts`，use cases 层通过三种方式消费——`agent-loop.ts` 采用参数注入、`session.ts` 直接持有并管理生命周期、`TracerLogPlugin.ts` 通过 provider 回调延迟获取实现解耦。

- **双轨并发写入安全策略**：框架使用两套差异化策略——`AgentTracer` 采用同步 `appendFileSync` 写入，利用 Node.js 单线程模型且按 `sessionId` 分文件，天然无竞争无需锁；长期记忆 `MEMORY.md` 使用 Promise-chain 互斥队列（`writeQueue`）对异步 `fs.promises.appendFile` 做显式串行化保障。

- **SessionManager 架构定位**：`SessionManager` 位于 `src/core/usecases/session.ts`，处于 use cases 层（核心业务逻辑层），继承 `EventEmitter` 并实现 `ChatUseCase` 接口，重构后定位为纯正的 ReAct 循环执行引擎，将周边逻辑下沉至 `RuleManager`、`ContextRepository`、`ToolDispatcher`、`CompactionService`、`ApprovalService` 等独立领域服务。


- **AgentTracer 注入策略**：`AgentTracer` 定义在领域层（`src/core/domain/tracer.ts`），在 use cases 层有三种使用方式：`session.ts` 直接字段持有并管理生命周期、`agent-loop.ts` 通过参数注入、`TracerLogPlugin` 通过 provider 回调函数延迟获取，体现了依赖注入与解耦的设计思路。

- **Tracer 并发写入策略**：`AgentTracer` 使用同步 `appendFileSync` 写入，利用 Node.js 单线程事件循环天然串行化，不同 session 通过 `sessionId` 生成独立文件名物理隔离，无需显式锁机制，且写入失败仅 `console.error` 不阻断主流程。

- **长期记忆写入互斥队列**：`SessionManager.queueWrite` 采用 Promise-chain 互斥模式（`writeQueue` 链式追加），将异步 `fs.promises.appendFile` 操作串行化，解决并发调用时的文件覆盖或交叉写入问题，同时自动触发向量化同步 upsert。

- **SessionManager 架构层级**：位于 `src/core/usecases/session.ts`（use cases 层），继承 `EventEmitter` 并实现 `ChatUseCase` 接口，是纯正的 ReAct 循环执行引擎，内部拆分四大领域服务（`RuleManager`、`ContextRepository`、`ToolDispatcher`、`CompactionService`）以及 `PluginRegistry` 插件注册中心。

- **SessionManager 核心职能**：负责会话全生命周期管理（初始化、配置加载、AgentTracer 实例化）、模型交互调度（驱动 AgentLoop 执行 ReAct 循环）、插件化生命周期钩子编排（注册 TokenWatermarkPlugin、JitRulesPlugin、TracerLogPlugin、LongTermMemoryPlugin 等）、长期记忆提炼与向量化同步。


- **AgentTracer 注入模式**：AgentTracer 定义在 src/core/domain/tracer.ts:53，采用三种差异化注入策略——session.ts 直接构造持有、agent-loop.ts 参数注入、TracerLogPlugin.ts 通过 provider 回调延迟获取，实现与插件的完全解耦。

- **并发写入双策略**：AgentTracer 使用同步 appendFileSync + 按 sessionId 分文件（天然无竞争）；长期记忆 MEMORY.md 使用 Promise 链式互斥队列（writeQueue）做显式串行化。所有写入失败均被 try/catch 吞掉，不阻断核心会话流。

- **SessionManager 架构定位**：位于 src/core/usecases/session.ts，继承 EventEmitter 并实现 ChatUseCase 接口，被 CLI 层和命令层直接引用，是用户态请求进入核心 usecases 层的统一入口。

- **SessionManager 核心职责**：化身"纯正的 ReAct 循环执行引擎"，将规则管理、上下文持久化、工具调度、上下文压缩、人工审批等周边逻辑下沉至 RuleManager、ContextRepository、ToolDispatcher、CompactionService、ApprovalService 五大领域服务，自身专注于驱动 AgentLoop 和管控插件注册中心（PluginRegistry）。

- **SessionManager 插件装配清单**：在构造函数中依次注册 TokenWatermarkPlugin、JitRulesPlugin、TracerLogPlugin、LongTermMemoryPlugin 等核心插件，通过洋葱模型串联各生命周期钩子，管制会话启动到结束的完整流程。


- **AgentTracer 组件定位**：定义于 `src/core/domain/tracer.ts:53`，属于领域层核心追踪类。采用依赖注入模式被消费——`agent-loop.ts` 通过参数注入、`session.ts` 通过字段持有并管理生命周期（多处 `new` 实例化）、`TracerLogPlugin` 通过回调函数延迟获取实现解耦。

- **并发写入双层策略**：框架对并发写入采用差异化设计。（1）AgentTracer 使用同步 `fs.appendFileSync` + 按 sessionId 分文件写入，利用 Node.js 单线程事件循环天然串行化，无需锁；（2）长期记忆 MEMORY.md 的异步写入采用 Promise-chain 互斥队列（`writeQueue`）显式串行化。两类写入失败均被 try/catch 吞掉并仅打 console.error，绝不阻断核心会话流。

- **SessionManager 架构层级**：位于 `src/core/usecases/session.ts`，属于 use cases（应用层），实现了 ChatUseCase 驱动端口。它并非领域层或适配层，而是纯正的执行引擎编排中心——初始化五大领域服务（RuleManager、ContextRepository、ToolDispatcher、CompactionService、ApprovalService）、注册六大插件生态、创建 AgentLoop 独立引擎，通过 EventEmitter 事件总线处理异步自唤醒调度。


- **AgentTracer 使用模式**：定义在 `src/core/domain/tracer.ts`，被 `session.ts`（字段持有）、`agent-loop.ts`（参数注入）、`TracerLogPlugin.ts`（provider 回调）三个 use case 文件消费，设计遵循依赖注入与解耦原则，写入失败统一 try/catch 不阻断主会话流。

- **并发写入安全双策略**：Tracer 组件使用同步 `appendFileSync` + 按 `sessionId` 分文件，依托单线程模型天然无竞争；长期记忆（MEMORY.md）使用异步 `fs.promises.appendFile` + Promise 链式互斥队列（`writeQueue`）做显式串行化保障。

- **SessionManager 架构定位**：位于 `src/core/usecases/session.ts`（核心用例层），继承 `EventEmitter` 并实现 `ChatUseCase` 接口，被 Interface 层（`cli.ts`、`commands/base.ts`）调用，是上层输入适配器与内部领域服务之间的门面。

- **SessionManager 六大职责**：① ReAct 循环执行引擎 ② 组装 5 个领域服务（RuleManager / ContextRepository / ToolDispatcher / CompactionService / ApprovalService）③ 管理 7 个插件的生命周期（洋葱模型管道）④ 持有并管理 AgentTracer 生命周期 ⑤ 事件总线与自唤醒调度 ⑥ 向上层暴露统一的 ChatUseCase 门面。
