## 背景

目前 `MyAgent` 通过内置的虚拟 MCP 服务 `LocalFileSystemMcpServer` 封装了基本的文件读取与写入功能，并通过 `SessionManager` 进行流程控制和大模型调度。
为了提高模型的信息定位能力和运行稳定性，避免模型在面对局部代码时因丧失全局视野而产生的反复试探，以及因推理错误导致的死循环调用，我们需要在虚拟 MCP 服务和 SessionManager 的调度流中植入 JIT 伴生规范注入、内置 Grep/Glob 检索以及工具循环的 Loop Prevention 熔断保护。

## 目标与非目标

**目标:**
- **限流 JIT Context 注入**：重构 `readFile` 工具，在读取目标路径文件时，能够沿着目录树向上自动寻找 `README.md` 或 `.rules`。但必须有根目录排除（不寻路至根目录）和跨会话/单轮的去重机制，防止 Token 重复堆叠爆仓。
- **支持任意文件按行精读**：改造 `readFile` 使其原生支持可选参数 `lineStart` 和 `lineEnd`，允许模型直接定位并提取任意文件的连续指定行，废除原先职责重叠的 `read_temp_file_by_lines` 声明。
- **内置 Grep/Glob 检索**：在 `LocalFileSystemMcpServer` 中新增 `grepSearch` 与 `globSearch` 两个工具，提供安全沙箱限制内的结构化全文检索与通配符查找。
- **Loop Prevention 熔断机制**：在 `SessionManager.chat()` 内植入对重复工具调用的监控，当检测到完全相同的工具及参数执行第 5 次时触发 `HARD BLOCK` 异常打断。
- **完全兼容性**：新机制必须完全与现有的虚拟 MCP 通信结构、`ToolRegistry` 和沙箱保护规范相兼容，无需对 UI/REPL 层做任何修改。

**非目标:**
- **外挂官方 MCP 进程**：坚决不引入外部官方的 `@modelcontextprotocol/server-filesystem` 进程。
- **全量 UI 改造**：不修改 REPL 命令行终端的流式渲染展示逻辑。
- **历史归档替换**：在此 Change 中不涉及历史消息的全量 XML 压缩折叠（Compaction 优化留待以后处理）。

## 架构决策

### 1. 基于 Node.js 原生的 `grepSearch` 实现 (Why X over Y?)
*   **决策**：使用 Node 虚拟文件系统遍历（`readdirSync` / `readFileSync`）与 JS 正则匹配实现，而非执行外部 `ripgrep` (rg) 进程。
*   **原因**：
    1. **环境无关性**：Agent 的宿主运行环境可能没有安装 `ripgrep` 二进制，使用原生 Node.js 可实现零依赖开箱即用。
    2. **沙箱边界统一**：原生遍历可直接复用 `secureResolvePath` 校验逻辑，无需处理外部进程管道泄露或命令注入逃逸问题。
    3. **性能足够**：对于标准工作区，原生深度优先遍历加正则匹配在几毫秒至几十毫秒内即可完成，配合条目上限和单行宽度限制（如 500 字符），在应用层防爆效果极佳。
*   **替代方案**：通过 `child_process` 运行 `rg`。因其需要宿主环境预装并存在命令逃逸风险而被否决。

### 2. 合并与升级 `readFileTool` 并处理向下兼容
*   **决策**：
    1. **前端废除**：从暴露给大模型的 `toolsDefinition` 列表中彻底删除 `read_temp_file_by_lines` 的定义，不再向模型推荐此工具。
    2. **底层兼容**：在 `LocalFileSystemMcpServer.callTool` 路由中，继续保留对 `read_temp_file_by_lines` 指令的解析。其核心执行转发给增强后的 `readFileTool` 逻辑。
    3. **引导重构**：修改 `src/brain/session.ts` 中的 `handleLargeToolOutput`，大文件截断输出中的提示词更改为：`请调用 "readFile" 工具，传入 "targetPath": "${relativePath}" 并指定起始和结束行。`
*   **原因**：合并后，大模型只需要面向单一的 `readFile` 工具，就能在“全量读取”与“区间读取”之间平滑切换，避免工具池污染，同时兼顾老会话历史上下文的无损流转。

### 3. Gated JIT Context (限流伴生规范注入) 机制 (对齐 Opencode 最佳实践)
*   **决策**：
    1. **根目录排除寻路**：在向上寻找规则文件（`README.md` 或 `.rules`）时，递归深度仅限于当前文件的父级目录，向上攀爬直到工作区根目录的前一级目录（即 `current !== root`）。因为工作区根目录下的全局规则已经由 System Prompt 初始化加载，不需要在每次工具读取子文件时都带上全局概述，以免导致极严重的 Token 膨胀。
    2. **全会话去重（Session Deduplication）**：不仅在单轮交互内去重，在 `SessionManager` 中还需要对整个会话历史中已经附加过的 JIT 规则进行全局 Set 去重（解析已往所有 `Message` 历史中是否曾经附带过该规则文件路径）。一旦某个规则文件已经被大模型在历史中读过，在此会话后续的任何 `readFile` 读取中都直接跳过注入。
    3. **单轮多工具调用去重（Turn Deduplication）**：在一次大模型输出多指令触发（比如并行读取两个同目录下的文件）中，确保相同的子目录规则在当次消息中仅被读取附带一次。
*   **原因**：完美对齐 Opencode 精英级的 Context 控制理念，将非必要的 JIT 重复渲染降为零，极大提高 Token 效能。

### 4. 基于内存哈希的 Loop 监控
*   **决策**：在 `SessionManager.chat()` 的 ReAct 循环生命周期内，维护一个键值对记录器。键值结构为：`${functionName}:${JSON.stringify(args)}`，值记录出现次数。
*   **原因**：在单次交互（一次 ReAct 多轮工具流转）中进行计数。一旦次数达到 5，主动强行 `throw new Error('[HARD BLOCK] ...')`，以此阻断大模型因逻辑受阻产生的无休止试探。

## 风险与权衡

- **[风险点] 大文件正则搜索导致 CPU 暴涨 (ReDoS)**
  - **缓解策略**：在 `grepSearch` 中限制检索的文件类型（如仅支持文本文件和已知源码扩展名），限制单次搜索的最大文件数量（如最多扫描 500 个文件），并对匹配的单行字符长度进行硬性截断（只保留前 500 字符），防止正则引擎在大文件超长单行中卡死。
- **[风险点] JIT 向上寻找文件导致无限死循环**
  - **缓解策略**：查找上级目录时设置硬顶哨兵条件——当到达 `authorizedDir`（授权工作区根目录）时必须终止递归，并且对路径深度超过 10 层的寻路抛出安全溢出保护。
