# 探索主题: MyAgent 核心架构缺陷与安全隐患深度剖析

## 1. 问题定义
在研究了当前项目 `my-simple-agent` 的核心 ReAct 推理大循环、生命周期管理、文件沙箱、终端命令过滤网关以及后台自省提炼子智能体的实现，并与 `Agents` 目录下 Claude Code、OpenClaw、Hermes Agent 等 7 个参考项目进行深度源码比对后，发现当前项目在**多进程优雅清理**、**上下文提炼策略**、**命令行注入防范**以及**后台自省超时阻断**等方面存在重大架构缺陷和安全漏洞，可能导致严重的僵尸进程堆积、Token 严重浪费、命令注入逃逸及后台死锁。

## 2. 关键发现与调研结果

- **代码库现状**：
  1. **信号退出竞态与泄露**：[index.ts](file:///d:/projects/MyAgent/src/index.ts#L80-L90)、[mcp-client.ts](file:///d:/projects/MyAgent/src/adapters/tools/mcp-client.ts#L68-L72) 以及 [browser-action.ts](file:///d:/projects/MyAgent/src/adapters/tools/tools/browser/browser-action.ts#L69-L71) 分别独立监听了进程退出信号 `SIGINT/SIGTERM`。当收到 Ctrl+C 时，`index.ts` 会立即同步调用 `process.exit(0)`，导致 `McpToolManager` 和 `BrowserSession` 的异步清理（如 `conn.transport.close()`、`chromium.context.close()` 等）尚未运行完毕就被强制切断。由于 Node 进程被暴力终止，在 Windows 上派生的 Python/Chromium 孙进程树无法被 `taskkill`，最终在系统后台留存大量僵尸进程。
  2. **提炼裁剪低效与冗余**：[CompactionService.ts](file:///d:/projects/MyAgent/src/core/usecases/CompactionService.ts#L60) 的硬截断策略过于粗暴，仅保留最后 4 条消息（`compactionRetainCount = 4`），造成 ReAct 多步任务的上下文严重断层。同时，[DefaultContextAdapter.ts](file:///d:/projects/MyAgent/src/adapters/context/DefaultContextAdapter.ts#L58-L88) 会将已裁剪历史中读写过的核心文件原文（最多 5 个，总计达 25000 tokens）以 `<transient_file>` 格式重新原封不动塞回头部 `system` 消息中。这不仅没有实现“压缩上下文”以减少 token 的目的，反而导致同一文件在上下文中重复出现（因为历史中的 tool_calls 结果可能仍包含该文件），造成极大的 Token 浪费和语义混淆。
  3. **终端安全网关字符漏拦截**：[terminal-guard.ts](file:///d:/projects/MyAgent/src/adapters/tools/tools/system/terminal-guard.ts#L16) 中用于防御复合指令拼接的 `COMPOSITE_REGEX = /[&|<>^%\r\n]/` 存在重大遗漏，漏掉了分号 `;`。在类 Unix 环境或 Git Bash 终端仿真器中，模型能轻易通过 `npm test ; cat /etc/passwd` 执行命令注入逃逸。另外，其针对修改 Git 状态的写倾向命令（如 `git commit`、`git checkout`）缺乏拦截，违反了“严禁执行除查看外的任何 Git操作”的安全规范。
  4. **后台自省子智能体无超时挂起**：[MemoryService.ts](file:///d:/projects/MyAgent/src/core/usecases/MemoryService.ts#L199-L288) 触发后台子智能体（Memory Sub-Agent）进行自省并提取 `MEMORY.md` 记忆。该子 Agent 采用独立的 `AgentLoop` 并在后台异步循环。但是，在调用 `driver.streamChat` 或等待 LLM 返回时，并没有传递任何外置 `AbortSignal` 或者是总时长 Timeout。如果网络阻塞或大模型接口挂起，该子 Agent 会在后台无限期占满 TCP 连接并挂死，在长时间运行下导致严重的句柄泄露。

- **核实与洞察**：
  1. **集中化生命周期协调**：在 [claude-code](file:///d:/projects/Agent/claude-code-analysis/src/setup.ts) 及其他优秀项目中，进程退出时有一个集中的生命周期管理器进行串联挂接。在接收退出信号后，它会在主进程调用退出前优雅地 `await` 每一个已注册连接和子进程的关闭，决不允许各模块竞态处理信号。
  2. **精准语义摘要而非源码重注**：[openclaw](file:///d:/projects/Agent/openclaw/src/agents/workspace-default.ts) 不会将已截断的文件内容原文注入上下文头部，而是仅保存高层次的修改记录，让模型在需要时自行去调文件读取工具。
  3. **基于 AST / 深度参数拆解的防护**：[claude-code](file:///d:/projects/Agent/claude-code-analysis/src/tools/BashTool/bashSecurity.ts) 不使用脆弱的黑名单正则，而是将 Shell 命令使用专门的解析器做 AST 化分析，能彻底拆分多段 pipeline，并对重定向符、分号、嵌套外壳进行全面审查。
  4. **超时熔断与级联强杀**：[hermes-agent](file:///d:/projects/Agent/hermes-agent/tools/approval.py) 对所有后台子任务配有严格的 `Timeout` 装饰器，并且当主 Session 发生 Abort 或者是主线程退出时，会把所有的 Sub-Agent 通过 AbortController 级联强杀，确保不遗留任何死锁请求。

## 3. 方案对比与推荐方向

### 方案 A (现有机制)
- 各模块各自抢先捕获并处理 `SIGINT/SIGTERM`，暴力调用 `process.exit(0)`。
- 硬性截断至 4 条消息，把大文件原文以 `<transient_file>` 形式塞回头部的 `system` 消息。
- 用简单正则校验非法字符，漏掉分号等字符，不对 Git 写指令进行安全过滤。
- 后台自省子智能体后台静默常驻，无超时机制与 AbortSignal 控制。

### 方案 B (推荐改进方案)
- **全局统一生命周期管理**：在 `index.ts` 中管理统一的 `cleanup` 队列，在捕获信号后，串行/并行 `await mcpManager.close()` 和 `await BrowserSession.close()`，确保连接正常优雅关闭且强杀孙进程树之后，最后由 `index.ts` 集中调用 `process.exit(0)`。
- **智能滑动窗口与增量更改摘要**：增大历史消息滑动窗口（例如 10-15 条），用已修改文件的“增量修改记录（Diff Summary）”代替原封不动的“大文件原文”，仅在模型实际需要读写时通过 tool 自动读取。
- **深度 AST 命令过滤网关**：使用 `shell-quote` 等 AST 工具解析完整命令行，阻止分号 `;`、反引号、嵌套 shell，并在白名单/黑名单中引入对 `git` 写操作（如 `git commit`, `git checkout` 等）的前置阻断。
- **子任务超时熔断与级联中断**：给后台自省子智能体和 LLM 接口调用挂接 `AbortSignal`，并对自省任务设置最大执行时长限制（如 60秒），超时强制 `abort`，防止死锁累积。

### 方案评估矩阵
| 评估维度 | 方案 A | 方案 B | 选型分析 |
| :--- | :--- | :--- | :--- |
| **内存/进程泄露防护** | 极低 ✗ | 极高 ✓ | 方案 B 彻底解决了 Playwright 和 MCP 的僵尸进程遗留。 |
| **Token 使用效率** | 极低 ✗ (严重冗余) | 极高 ✓ (增量轻量) | 方案 B 避免了 2.5W Token 的大文件原文重复注入，极大降低开销。 |
| **命令防注入安全性** | 低 ✗ (分号可穿透) | 高 ✓ (AST 解构防护) | 方案 B 的 AST 拆解能彻底防御包括分号在内的复杂命令注入。 |
| **后台运行稳定性** | 容易挂死 ✗ | 稳定 ✓ (超时保障) | 方案 B 为 Sub-Agent 提供强力的超时与级联强杀护栏。 |

**推荐路径**：采用**方案 B** 作为演进方向。建议优先修补“全局统一生命周期管理”以解决迫在眉睫的进程泄露问题，然后演进“深度 AST 命令过滤网关”以堵塞安全漏洞，最后优化上下文提炼机制。

## 4. 约束、风险与未知项
- **AST 解析兼容性**：在 Windows PowerShell 复杂脚本块（如带有 `& { ... }` 格式）下，常规 of AST 解析库可能无法完全精准解析其结构，需要特别小心处理参数转义。
- **提炼质量衰减**：用“修改 Diff 摘要”代替“大文件原文”会增加对大模型理解能力的依赖。如果增量摘要生成得不够精细，大模型在上下文截断后可能需要更频繁地去读取文件，这会产生一定的 Tool 轮数开销。

## 5. 否决方案
- **直接禁用自省子智能体**：虽然自省任务有卡死风险，但自省是构建长期记忆、记录用户偏好和教训的核心所在，直接砍掉会严重削弱 Agent 的自适应进化能力。
- **强制使用全局 Docker/虚拟机物理沙箱**：虽然能提供极高安全，但在本地轻量级 CLI 工具场景下，物理虚拟机部署成本过高且环境极度笨重，与本项目“通用极简智能助手”的设计初衷不符，因此予以舍弃。
