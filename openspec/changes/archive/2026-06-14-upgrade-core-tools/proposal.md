## 改造原因

目前 `MyAgent` 在文件读取和检索方面存在以下痛点，阻碍了智能体的高效运行和安全性：
1. **输入过载与全局视野丢失**：大模型执行局部代码读取时缺乏全局项目的架构规范视野（如无法感知目录下的 `.rules` 或 `README.md`）。另外，目前的 `readFile` 仅支持全量读取，而分页读取被隔离在专门针对临时文件的 `read_temp_file_by_lines` 工具中。这导致大模型在读取正常的工程文件时只能生吞全文，极大浪费了 Token，并增加了崩溃概率。
2. **死循环调用问题**：当大模型因推理陷入死循环或遇到不存在的文件时，会在无意义的读取操作中陷入重复调用（即死循环），导致 Token 极大浪费和推理卡死，系统缺乏底层的硬打断（Loop Prevention）机制。
3. **检索手段缺失**：模型缺少原生的全局文本检索（Grep）和模式检索（Glob）工具，迫使其通过全量读取文件目录或写终端脚本检索，性能极差且极易引发命令逃逸风险。

为了在“上下文去重与缓存机制”的改造前铺好底层防爆和精准检索的基石，我们需要立即对工具底座进行升级。

## 变更内容

1. **改造 `readFile` 工具 (合并与彻底替代 `read_temp_file_by_lines`)**：
   - **核心升级**：`readFile` 工具新增可选参数 `lineStart` 和 `lineEnd`，使其原生具备读取任意文本文件（包括临时落盘的大文本文件）指定行区间的能力。
   - **废除 `read_temp_file_by_lines` 声明**：从暴露给大语言模型的 `toolsDefinition` 中彻底移除 `read_temp_file_by_lines`。但为了兼容老会话恢复，在虚拟 MCP 路由层保留该指令解析，内部默默重定向至 `readFileTool`。
   - **限流 JIT 伴生规范注入 (Gated JIT Context - 对齐 Opencode 核心规范)**：
     - **向上溯源边界（Root Exemption）**：在读取文件时，向上级目录递归寻找 `README.md` 或 `.rules`。寻路边界上限为工作区根目录**（不含根目录本身）**。因为根目录下的全局规则已经由 System Prompt 初始化加载，绝不再在工具级重复附加。
     - **全会话去重与单轮过滤**：维护全局规则路径集合与当前会话已注入规则文件的 Set 记录。若寻找到的规则文件已被全局规则包含，或在历史对话中已经被注入过，亦或在当前交互轮次中已经注入过，**直接默默过滤**，绝不重复返回以防止 Token 堆积。
2. **升级 `SessionManager` 控制流**：
   - **截断导流提示语重构**：修改 `handleLargeToolOutput`。当大文件落盘时，提示模型使用统一 of `readFile`（而非 `read_temp_file_by_lines`）配合行参数进行分页精读。
   - **增加死循环硬阻断（Loop Prevention）**：监控每轮交互中工具调用的哈希。若同一轮交互中完全相同的函数+参数被重复执行了 4 次以上，立刻抛出 `HARD BLOCK` 异常，中断推理流，强行拉回模型的思维。
3. **新增内置检索工具**：
   - 实现原生 `grepSearch`：基于正则表达式和纯文本检索，支持输出内容截断、返回上限（防爆）和匹配计数（`count` 模式）。
   - 实现原生 `globSearch`：基于通配符定位工作区文件。

## 业务能力

### 新增业务能力
- `grep-search`: 提供基于正则表达式与纯文本的结构化全文检索工具，包含条目硬限制、单行宽度截断和 `count` 统计匹配行数模式。
- `glob-search`: 提供基于通配符模式的文件查找工具，快速定位工程文件结构。

### 修改业务能力
- `virtual-mcp-server`: 升级虚拟 MCP 文件服务器提供的读取服务，使其在读取物理文件时支持 JIT Context 伴生规范的注入与解析，原生支持指定行局部精读，并为 `read_temp_file_by_lines` 提供向下兼容路由。
- `simple-agent-core`: 在智能体核心交互流程（ReAct 循环）中加入对工具调用重复哈希的拦截（Loop Prevention），更新大文件截断输出提示语引导至 `readFile`。

## 影响范围

- **受影响代码**：
  - `src/action/tools.ts`：更新 `readFileTool` 实现，并在 `toolsDefinition` 中移除 `read_temp_file_by_lines` 描述，新增 `grepSearch` 与 `globSearch`。
  - `src/action/virtual-mcp.ts`：注册新增工具的 Schema，更新 `readFile` 接受可选的 `lineStart` 和 `lineEnd`，并保留老调用路由至 `readFileTool`。
  - `src/brain/session.ts`：在 `chat()` 中新增 Loop Prevention 熔断与 JIT 注入去重上下文传递；修改 `handleLargeToolOutput` 中的大文件截断落盘提示，将其重定向至 `readFile` 工具调用说明。
- **依赖与 API**：
  - 核心接口中 `read_temp_file_by_lines` 被移除，`readFile` 功能增强，新增 `grepSearch` 和 `globSearch`。
