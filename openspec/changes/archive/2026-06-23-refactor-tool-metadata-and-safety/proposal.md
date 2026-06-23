## 改造原因

系统目前在**上下文语义保留**、**高危写操作安全审批**、**多路工具执行效率**与**挂起容错**等方面存在多项架构设计缺陷：
1. **文件追踪与安全拦截失效**：`CompactionService` 和 `LocalFileSystemMcpServer` 均硬编码匹配了旧文件工具名（`readFile`/`writeFile`）及参数名（`targetPath`）。在新工具链下，高危的写文件覆盖操作完全绕过了 `waitApproval` 安全防护，且压缩时最近操作文件的历史追踪功能彻底失效。
2. **串行阻塞瓶颈**：`AgentLoop` 在面对 LLM 下发的并行工具请求时，采用强制的串行循环遍历，阻碍了 I/O 吞吐和响应效率。
3. **卡死死锁风险**：没有全局的工具调用超时阻断与进程强杀机制，任何外部 MCP 服务的挂死都会直接导致主事件循环卡死挂起。

为消除安全死角，提升并发执行效率并增加系统鲁棒性，亟需进行本期核心重构。

## 变更内容

1. **工具元数据契约解耦 (BREAKING)**：在 `NativeTool` 契约接口中引入可选属性（如 `filePathParamKey?: string`），允许工具自我声明路径参数名。重构 `CompactionService` 和 `LocalFileSystemMcpServer`，消除名称硬编码，统一根据元数据抓取路径和判定审批。
2. **多态向后兼容兜底**：设计安全防御降级策略，对于未定义元数据的存量或第三方旧工具，默认视为最高危的写级别强制进入审批屏障，防止发生绕过。
3. **并发调用与文件读写锁**：重构 `AgentLoop` 中工具执行逻辑为 Promise 并发调度。同时，为了防范并发下同一文件读写冲突，引入针对文件路径（`TargetFile`/`AbsolutePath`）粒度的读写锁（Read-Write Lock），确保相同文件的命令保持串行，不同文件的 I/O 彻底并行。
4. **Abort 超时阻断守护**：在工具调度的 `Context` 中强注入全局的超时熔断机制，在调用卡死时通过 `AbortController` 实施限时熔断，守护主事件循环。

## 业务能力

### 新增业务能力

- `tool-concurrency-lock`: 基于文件路径粒度读写锁的工具多路并发并行执行与冲突规避。

### 修改业务能力

- `tool-security-category`: 强化安全类别识别，针对无声明的第三方或旧工具实施严格的硬拦截兜底防护。
- `context-compaction`: 消除最近操作文件收集的硬编码限制，采用动态的元数据契约对操作文件路径实施语义化追踪。
- `human-approval`: 升级写操作的安全审批判定，将其从固定指令名称检查升级为通用的元数据属性判定。

## 影响范围

- `src/ports/driven/ToolRegistryPort.ts` (升级工具端口元数据定义)
- `src/adapters/tools/virtual-mcp.ts` (重构 `LocalFileSystemMcpServer` 审批拦截)
- `src/core/usecases/CompactionService.ts` (基于元数据重构最近文件收集)
- `src/core/usecases/agent-loop.ts` (重构并行执行、引入读写锁与超时 `AbortController`)
- `test/` (更新各模块的单元测试及集成测试)
