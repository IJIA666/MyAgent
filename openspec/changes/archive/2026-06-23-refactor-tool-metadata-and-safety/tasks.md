## 1. 元数据契约适配与安全拦截重构

- [x] 1.1 修改 `src/ports/driven/ToolRegistryPort.ts` 及 `src/adapters/tools/virtual-mcp.ts`，为 `NativeTool` 及 `ToolRegistryPort.callTool` 契约扩充可选的 `filePathParamKey?: string` 元数据定义及可选的 `signal?: AbortSignal` 传入。
- [x] 1.2 升级现存原生文件读写工具（`view_file`、`write_to_file`、`replace_file_content` 等），显式适配 `filePathParamKey` 契约；并在 `LocalFileSystemMcpServer` 拦截处基于工具元数据重构安全确权，对缺少声明的工具以降级防御态度执行 `waitApproval` 强制拦截。
- [x] 1.3 重构 `src/core/usecases/CompactionService.ts` 中的操作路径收集器 `collectReadToolFilePaths`，动态根据工具元数据中指示的 `filePathParamKey` 解析出被读写的代码文件绝对路径，并在无声明时执行参数名启发式解析。

<!-- checkpoint: npm run build -->

## 2. 并行调度与路径级读写锁实现

- [x] 2.1 编写基于绝对物理路径粒度的轻量读写锁机制 `FileLockManager`，当 LLM 发起并发请求时，若对同一路径发生写冲突，能够进入串行队列锁定排队，其他无关文件 I/O 开启完全并行。
- [x] 2.2 重构 `src/core/usecases/agent-loop.ts` 中的工具迭代，利用 `Promise.all` 实行多路工具并发调用调度，并在调用前进行路径解析、注入 `FileLockManager` 进行竞态冲突串行化编排。

<!-- checkpoint: npm run build -->

## 3. 超时阻断守护与单元测试验证

- [x] 3.1 在 `agent-loop.ts` 中设定默认或配置的超时时限，在发起调用时向子模块强注入由 `AbortController` 控制的 `AbortSignal`；若超时则执行熔断终止，强杀外部挂起连接释放事件循环。
- [x] 3.2 补充并更新对应的单元测试（涵盖元数据追踪收集、高危写操作硬拦截、同一文件并发冲突锁排队以及工具执行超时 Abort 物理强杀），执行全量单元测试与 ESLint 校验。

<!-- checkpoint: npm run test -->
<!-- checkpoint: npm run lint -->
