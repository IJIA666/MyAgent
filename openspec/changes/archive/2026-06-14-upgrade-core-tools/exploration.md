# 探索主题: 底层基建工具库升级探讨

## 1. 问题定义
大模型感知代码世界极其依赖底层的读写与检索工具（Tools）。目前 `MyAgent` 存在以下痛点：
1. `readFile` 与 `read_temp_file_by_lines` 较为割裂，且缺乏防死循环（Loop Prevention）、Staleness 校验及 JIT Context（情境感知规范注入）等企业级防爆机制。
2. 缺乏原生的 `grep_search`（正则/文本匹配）与 `glob_search`（文件名匹配）工具，模型常常需要全量读取整个目录或编写复杂的终端脚本，既低效且易引发 Token 爆炸或权限逃逸。
因此，亟需对现有底座工具实施重构升级，在降低 Token 消耗的同时大幅度提升 Agent 的安全防线。

## 2. 关键发现与调研结果
- **代码库现状**：
  - `MyAgent` 在 `src/action/` 中使用 `ToolRegistry`、`McpToolManager` 和 `LocalFileSystemMcpServer`（虚拟 MCP）形成了非常超前的 MCP 路由系统。
  - 大文件防爆方面，已在 `SessionManager` 中通过 `handleLargeToolOutput` 实现了超 8000 字符落盘临时文件及分页导流。
  - 上下文压缩方面，已实现了基于 Token 预估水位的 `compact()` 压缩提炼。
- **核实与洞察**：
  - 根据对前沿项目（Opencode、Claude Code、Hermes、Openclaw、gemini-cli 等）的深度调研：
    1. **JIT Context**：`gemini-cli` 的 `ReadFileTool` 和 Opencode 会在读取文件时自动向上溯源并将 `README.md` 或相关规范作为 `<system-reminder>` 后缀默默注入以辅助对局部代码的全局理解。
    2. **死循环阻断**：`Hermes` 引入了对重复未变更文件读写调用的拦截，若同一指令发起 4 次以上完全一样的调用则抛出 HARD BLOCK 强阻断。
    3. **Grep 标配**：Claude Code 极力推崇原生 `grep` 工具以取代终端子进程命令，极限制约返回字符和宽度（如最多 100/250 条，限定单行字符宽度防爆）。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 A (原生定制虚拟 MCP) | 方案 B (外挂官方 MCP Server) | 结论 |
| :--- | :--- | :--- | :--- |
| **可定制性 (如 JIT/防爆)** | 极高 ✓ (完全自主掌控输入流，容易在 `readFileTool` 增添 JIT 伴生提示词、大文件首尾截断预览) | 极低 ✗ (官方 Server 行为单一，不支持嵌入特定 Agent 的防爆与 JIT 规则) | A 占优 |
| **开发与维护成本** | 中 ✗ (需要手动编写 TS/JS 版本的 Grep 匹配、Glob 解析，并注册路由) | 低 ✓ (直接配置 MCP 选项拉起官方 npm 运行即可) | B 占优 |
| **安全沙箱控制** | 高 ✓ (可通过 `secureResolvePath` 强力阻断路径遍历与特殊设备读写) | 高 ✓ (官方自带安全沙箱策略，限制访问工作区目录) | 平手 |
| **规范统一性 (MCP)** | 高 ✓ (当前代码中已用虚拟 MCP 进行路由封装，完全适配) | 极高 ✓ (纯正外部标准服务，代码侵入最小) | B 占优 |

**推荐路径**：选择 **方案 A（原生定制虚拟 MCP）**。
*理由*：虽然官方提供的 filesystem mcp server 开发成本低，但它是通用的、缺乏对于 Agent 推理环境的高级定制（如：智能行截断导流、JIT 伴生规范注入、死循环硬阻断等）。这三大特性是前沿 Agent（Claude Code/Hermes/Opencode）拉开代差的关键。我们已有的 `LocalFileSystemMcpServer` 是一座桥梁，在此基础上升级工具既能享受 MCP 的标准化路由，又能保留极致的个性化防爆及引导特权。

## 4. 约束、风险与未知项
- **里普格雷普 (Ripgrep) 依赖**：如果原生 TS 实现 Grep，大规模代码库的正则性能将面临瓶颈。因此在 `grepSearch` 的底层实现中，我们需要评估是完全手写 TS/Node `fs` 逐行正则扫描，还是借助本地 `ripgrep` 执行（需保证环境兼容性）。
- **JIT 重复读取性能**：如果频繁向上溯源 `README.md`，可能导致过多的 `existsSync` 文件 IO 开销，需要设计合理的目录缓存以提升效率。

## 5. 否决方案
- **方案 B (完全切换为官方 filesystem MCP)**：被否决。官方 MCP Server 无法在读取时智能塞入 JIT Context（局部阅读伴生规范），也无法精细地与 `SessionManager` 联通实施 Loop Prevention，会削弱智能体的深度代码解析能力。
