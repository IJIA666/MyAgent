## 1. 升级底层核心工具 (tools.ts)

- [x] 1.1 改造 `readFileTool`：支持可选参数 `lineStart` 和 `lineEnd`，实现任意文本文件按行号区间局部精读；并支持 JIT 伴生规范注入，读取时顺着目标路径递归向上寻找 `README.md` 或 `.rules` 文件。**要求排除工作区根目录下的规范文件**（寻路截止于根目录的直接子级，不爬升至根目录本身），避免重复带入全局文档造成 Token 暴涨。
- [x] 1.2 在 `tools.ts` 中手写并实现原生 TS `grepSearch` 全文检索函数。支持纯文本与正则表达式匹配，支持匹配行最大 500 字符宽度截断，支持只统计匹配行数的 `countOnly` 模式，并自动过滤二进制文件和 `.git` 等隐藏目录。
- [x] 1.3 在 `tools.ts` 中手写并实现原生 TS `globSearch` 文件通配符检索函数。根据传入的通配符 pattern 定位并返回符合条件的文件相对路径列表（最大条数硬限制为 100 条）。
- [x] 1.4 升级 `tools.ts` 中的 `toolsDefinition` 描述契约：为 `readFile` 增加可选的 `lineStart` 和 `lineEnd` 参数定义；彻底移除 `read_temp_file_by_lines` 的定义声明；同时添加 `grepSearch` 和 `globSearch` 的详细定义。

<!-- checkpoint: npm run build -->

## 2. 升级虚拟 MCP 路由层 (virtual-mcp.ts)

- [x] 2.1 修改 `virtual-mcp.ts` 中的 `LocalFileSystemMcpServer.callTool`，在 `readFile` 路由中接收并处理可选参数 `lineStart` 和 `lineEnd`，并传导给 `readFileTool`。
- [x] 2.2 修改 `virtual-mcp.ts` 中的 `LocalFileSystemMcpServer.callTool`，在 `read_temp_file_by_lines` 路由中，将核心处理重定向调用 `readFileTool`，以保证老会话的向下兼容性。
- [x] 2.3 修改 `virtual-mcp.ts` 中的 `LocalFileSystemMcpServer.callTool`，实现对 `grepSearch` 请求的拦截校验、参数解析并委托执行。
- [x] 2.4 修改 `virtual-mcp.ts` 中的 `LocalFileSystemMcpServer.callTool`，实现对 `globSearch` 请求的拦截校验、参数解析并委托执行。

<!-- checkpoint: npm run build -->

## 3. 升级会话交互控制流 (session.ts)

- [x] 3.1 修改 `session.ts` 中的 `handleLargeToolOutput` 函数：将其中大文件落盘提示中的工具引导由 `read_temp_file_by_lines` 修改为 `readFile`，并提示使用其行数区间参数进行局部读取。
- [x] 3.2 修改 `session.ts` 中的 `SessionManager.chat()` ReAct 循环流，在循环开始前初始化当前轮次已执行工具调用指纹的追踪对象。
- [x] 3.3 在 `session.ts` 结合消息历史，实现 JIT 伴生规范的**全局去重与单轮去重机制**：向上回溯历史消息中已经成功加载的规则文件路径集合；且在单轮交互内也进行 Set 记录拦截，确保相同的规则文件在会话生命周期内只被附带返回给模型一次。
- [x] 3.4 实现死循环阻断（Loop Prevention）监控：在每次模型准备触发工具前校验该计数器，如果完全相同的工具请求已连续发起达 5 次，立即抛出包含 `HARD BLOCK` 的致命打断错误，强行释放当前推理阻塞。

<!-- checkpoint: npm run build -->
