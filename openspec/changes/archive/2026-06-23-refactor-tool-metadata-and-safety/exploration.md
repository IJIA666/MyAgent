# 探索主题: 智能体核心架构缺陷与安全隐患审计

## 1. 问题定义
在对 MyAgent 核心引擎（包括 AgentLoop、CompactionService、LocalFileSystemMcpServer）进行全量源码走读，并结合业界先进智能体（如 Claude Code）的竞品对比后，发现系统在**上下文语义保留**、**高危操作安全拦截**、**多路工具执行效率**以及**异常容错**等 4 个维度上存在 5 项关键的架构设计缺陷，导致长对话时模型易失忆、高危写入操作能绕过审批、I/O 吞吐受限以及子进程易死锁挂起。

## 2. 关键发现与调研结果
- **代码库现状**：
  1. **Compaction 文件追踪失效**：在 `CompactionService.ts` 的 `collectReadToolFilePaths` 中，系统采用硬编码形式识别 `readFile`/`writeFile` 及其参数 `targetPath`。但在新工具链中已重构为 `view_file` (参数 `AbsolutePath`) 和 `write_to_file` / `replace_file_content` (参数 `TargetFile`)。这导致长会话压缩后，历史被编辑文件全部漏掉，模型遗失了当前操作的文件对象上下文。
  2. **安全审批可规避漏洞**：在 `virtual-mcp.ts` 的 `LocalFileSystemMcpServer.callTool` 中，危险写操作的物理确认被硬编码为仅匹配 `deletePath`、`writeFile` 以及参数 `targetPath`。当调用新的文件修改工具 `write_to_file` 或 `replace_file_content` 覆盖重写文件时，安全审批机制（waitApproval）将被 100% 绕过。
  3. **工具串行阻塞**：`agent-loop.ts` 采用串行循环控制工具执行。大模型返回的并行工具请求（如多文件读取）被迫进行线性串行等待，在海量 I/O 操作时产生了显著性能瓶颈。
  4. **硬截断脆弱兜底**：在异步摘要提炼任务 Pending 或熔断失败时，`CompactionService.compact()` 会粗暴执行指针截断并拼接空的 StaticFallback 摘要，导致长对话出现逻辑断层和模型“彻底失忆”。
  5. **死锁风险**：工具执行无 Timeout 控制，底层的 MCP 卡死会引发生命周期的无限挂起。
- **核实与洞察**：
  Claude Code、Hermes Agent 等成熟产品会在工具层暴露丰富的元数据（Metadata，如 `securityCategory`, `targetFileParamName` 等），从而将安全审查、操作审计与业务实现解耦。同时，提供强有力的超时守护（AbortController/Guard Timer）和多路异步并发（Concurrency Promise.all）来确保在高吞吐与高危场景下的稳定与安全。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 A：引入工具元数据并重构拦截器（推荐） | 方案 B：就地扩展硬编码条件判定 | 结论 |
| :--- | :--- | :--- | :--- |
| **可扩展性** | 优秀 ✓：后续新增任意工具均可通过继承 NativeTool 元数据自动支持文件追踪和安全审计。 | 差 ✗：每次增删工具都必须修改多个核心系统模块。 | 方案 A 占优 |
| **实现代价** | 中等：需要微调 `NativeTool` 契约声明及 `ToolRegistry` 并更新拦截器。 | 极低：在 Compaction 与 MCP 拦截处增加 `if-else` 分支。 | 方案 B 占优 |
| **系统安全性** | 优秀 ✓：由工具自身暴露高危属性，消除隐式规避漏洞的死角。 | 中等：手工维护匹配规则，随着工具扩展极易遗漏。 | 方案 A 占优 |

**推荐路径**：
优先采纳 **方案 A**，对系统进行架构层级的健壮性加固。首期优先修复 **Compaction 文件追踪失效** 和 **高危写操作安全审批被绕过** 两个严重缺陷。通过为 `NativeTool` 定义统一的元数据契约（例如 `filePathParamKey?: string` 以及完善的 `securityCategory` 映射），从根本上消除硬编码耦合，确保新工具的路径跟踪和审批安全。

## 4. 约束、风险与未知项
- **向后兼容性与兜底降级**：修改 `NativeTool` 契约会影响现存的大量内置工具（如 gitTools、systemTools 等）。新扩展的元数据属性应全部设计为可选属性。对于缺失声明的存量或第三方旧工具，拦截器与调度器应实行严苛的硬拦截兜底防护（如默认视作最高危操作强制审批），防止发生重构引起的安全失守。
- **并发文件读写竞态冲突**：若在后期实现并行工具调用，当 LLM 下发包含同一目标文件的并行读写指令时，极易因并发操作导致文件内容锁竞争或顺序数据损坏。系统必须引入按文件路径（`TargetFile`/`AbsolutePath`）粒度的**读写锁（Read-Write Lock）**，使针对同一文件的操作保持串行，仅不同文件的 I/O 开启并行。
- **超时阻断与生命周期守卫**：对于外部 MCP 工具连接或不可控的长任务，在引入超时时必须在工具调度的上下文（Context）中强注入基于 `AbortController` 的全局超时控制，保证主事件循环不因下游工具挂死而无限期阻塞。

## 5. 否决方案
- **方案 B（简单堆砌 if-else 规则）**：因不能从根本上解决工具库扩展时的耦合问题，极易造成未来的二次安全失守，故予以否决。
