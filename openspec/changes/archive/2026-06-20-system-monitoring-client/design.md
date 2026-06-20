## 背景

在 Phase 1 中，我们在 `monitoring_server/` 目录下实现了精细化监控的 Python 外部 MCP 服务端。该服务端通过 Stdio 协议对外传输，且强制依赖 Administrator 权限。本设计旨在完成 Node.js Agent 客户端的集成，包括注册 Stdio 进程配置、实现管理员权限缺失崩溃的友好拦截、以及为 Agent 注入用于系统分析和带宽诊断的工具能力。

## 目标与非目标

**目标:**
1. 注册 Stdio 连接配置：在 `mcp_config.json` 中配置监控服务端的启动参数，命令为 `uv --directory monitoring_server run python main.py`。
2. 管理员权限崩溃防御：在 Agent 启动外部 MCP 服务子进程时，若因为权限不足而导致子进程以错误码 1 退出，Agent 的连接管理器必须(MUST)捕获并解析其 `sys.stderr` 错误，中止重试，并在 Cli 主界面输出显式的红色提权引导警告。
3. 保证主程序健壮性：外部监控服务启动失败时，Agent 客户端应当正常降级启动，不应该导致 Agent 主控制台进程彻底崩溃退出。

**非目标:**
1. 不对 Python 监控服务端的代码与业务进行任何侵入性修改。
2. 客户端主进程不负责动态自动提权。
3. 不添加多余的图形化显示，指标仅由 Agent 以 Cli 的文本/表格或分析报告形式呈现。

## 架构决策

1. **统一在 `mcp_config.json` 中声明 Stdio 服务端配置**：
   - **Why**：当前 IJIA Agent 的 `McpToolManager`（[src/action/index.ts](file:///d:/Projects/MyAgent/src/action/index.ts)）读取 `mcp_config.json` 并动态加载所有的外部工具。将其写入配置文件可以遵循项目已有的外部工具集成标准，零侵入地引入 `SystemMonitoringServer`。
2. **在 `McpToolManager` 子进程启动层进行 stderr 管道捕获与错误拦截**：
   - **Why**：如果子进程因为没有管理员权限而 Fail-Fast 退出，如果不去捕获它的 `stderr`，Agent 的 JSON-RPC 客户端会抛出不透明的 `connection closed` / `EOF` 异常。通过在 Node.js `spawn` 返回的 `childProcess.stderr` 上挂载数据监听器，并对 `requires Administrator privileges` 特征字符进行正则匹配，能够在第一时间向用户指出核心故障根因。

## 风险与权衡

1. **风险：用户未以管理员身份启动 Agent 时引发启动死锁或主进程崩溃**
   - **权衡与缓解**：在 [McpToolManager](file:///d:/Projects/MyAgent/src/action/index.ts) 中对 Stdio 进程的 `error` 和 `exit` 事件做异常拦截。一旦匹配到特权不足特征错误，应当立即将该外部 server 状态标为失效（禁用），仅在界面上使用红色主题控制台日志打印“温馨提示”，随后允许 Agent 正常加载其他内置工具和交互，绝不引发主控制台崩溃退出。
