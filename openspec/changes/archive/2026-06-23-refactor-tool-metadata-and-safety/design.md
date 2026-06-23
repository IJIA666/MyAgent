## 背景

当前系统在上下文压缩（Compaction）和物理安全拦截中存在名字硬编码强耦合，导致新工具链无法被追踪且高危修改容易被绕过。同时，核心执行循环采用串行阻塞方式处理多路工具调用，缺乏基于文件锁的安全机制和超时阻断防护，易发生数据竞态和无限挂起死锁。本设计将提供高扩展性、高安全的工具元数据与调度重构方案。

## 目标与非目标

**目标:**
- 消除 `CompactionService` 和 `LocalFileSystemMcpServer` 拦截逻辑中的工具名硬编码，统一根据工具元数据进行操作文件路径抓取和危险写判定。
- 为缺失元数据的存量及第三方旧工具提供硬拦截兜底防护，防止权限被静默规避。
- 在 `AgentLoop` 中引入 `Promise.all` 并行工具调度，提升多文件读写的并发吞吐效率。
- 实现基于物理文件路径粒度的**读写锁（Read-Write Lock）**，相同文件的命令退化为串行锁排队，互不干涉的文件操作完全并行。
- 在工具调度生命周期内注入 `AbortController`，在超时时强杀挂死连接，保证主事件循环不被卡死。

**非目标:**
- 不重构核心 MCP 通信物理管道协议，保持当前的进程生命周期管理。
- 不修改外层 CLI/UI 交互层的交互呈现逻辑。

## 架构决策

### 1. 工具元数据解耦契约与多态向后兼容
- **ToolMetadata 统一接口定义**：
  在 `src/ports/driven/ToolRegistryPort.ts` 中提炼并导出统一的元数据类型 `ToolMetadata`：
  ```typescript
  export interface ToolMetadata {
    readonly name: string;
    readonly securityCategory: 'read' | 'write';
    readonly filePathParamKey?: string; // 可选的文件路径参数键名，如 view_file 对应 "AbsolutePath"
  }
  ```
  使 `ToolRegistryPort.getTool(name)` 以及 `NativeTool` 继承并声明此返回结构，避免元数据零散膨胀。
- **向后兼容兜底拦截**：
  在 `LocalFileSystemMcpServer` 审批拦截中，如果检测到工具未定义或未提供 `ToolMetadata`，系统自动将其判定为最高危的 `write` 类别，强行拉起人机交互审批（waitApproval），杜绝安全漏洞。

### 2. 基于路径的读写锁与 Promise.allSettled 异常隔离
为了在工具并发执行时规避对同一个文件的读写竞态冲突（如同时下发读写操作），引入文件级锁管理器 `FileLockManager`：
- 以绝对物理路径（`AbsolutePath`/`TargetFile` 参数值经过 resolve 后的路径）为 Key 维护排队锁队列。
- 当大模型下发多个工具时，调度引擎分析各个调用参数，解析出其关联的文件路径：
  - 若路径不同，彻底开启多路并发 Promise 执行。
  - 若包含相同路径且其中包含写（`write`）操作工具，则将针对该路径的工具调用串行化，在锁队列中排队 await 串行执行。
- **异常隔离容错（Promise.allSettled）**：
  在 `AgentLoop` 中，使用 `Promise.allSettled` 代替 `Promise.all` 异步调度被锁编排后的多路执行。若其中某个工具因路径不存在等原因发生错误，`Promise.allSettled` 仅捕获该工具对应的 `rejected` 结果，并将其转化为 ToolResponse 错误反馈给模型，决不阻断或影响其他正常运行的工具（防范“一损俱损”）。

### 3. AbortController 超时熔断与底层彻底穿透
- 在 `ToolRegistryPort.callTool` 及 `NativeTool.execute` 契约签名中扩展可选的 `signal?: AbortSignal` 传参。
- **超时信号彻底穿透**：
  在 `AgentLoop` 触发超时 `AbortController.abort()` 时，`AbortSignal` 必须物理传递并穿透到底层：
  1. **文件读写（fs.promises）**：在原生文件工具（如 `ReadFileTool` / `WriteFileTool`）执行 I/O 时，必须将 `signal` 作为配置参数传给 `fs.promises.readFile(path, { encoding: 'utf-8', signal })` 等方法以响应原生阻断。
  2. **终端脚本（exec）**：在 `ExecuteCommandTool` 中，将 `signal` 穿透传入底层的 `child_process.exec(cmd, { signal })` 中以物理终止悬空子进程。
  3. **MCP 通信信道**：在 `McpToolManager` 通信层及连接请求中监听 `signal.onabort`，一旦触发，立即强行断开并清理该 MCP 通信连接。

## 风险与权衡

### 外部 MCP 工具路径参数抓取的局限性
- **已知风险**：通过外部标准 MCP 协议拉起的第三方工具（没有本地 `NativeTool` 代码声明），无法静态继承 `filePathParamKey` 属性。
- **缓解策略**：
  在 `CompactionService` 文件提取和 `LocalFileSystemMcpServer` 中建立通用参数名启发式扫描。若工具无 `filePathParamKey` 显式声明，则在 arguments 中扫描常用路径参数（如 `targetPath`、`path`、`filePath`、`target`、`file` 等）。若匹配到且值为有效字符串，则提取并将其纳入锁机制和追踪范围，最大化增强第三方工具的兼容性与安全性。
