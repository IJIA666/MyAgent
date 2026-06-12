## 背景

在当前智能体底座的动作执行与工具沙箱子系统中，存在三个关键的设计与实现质量问题：
1. **沙箱边界逃逸漏洞**：`secureResolvePath` 防御路径穿透（Path Traversal）时只使用了 `startsWith` 进行前缀比对，容易因同前缀目录（如 `/authorized/path-secret` 匹配 `/authorized/path` 成功）导致越位访问。
2. **生命周期回收与内存泄露风险**：`McpToolManager` 在全局进程信号（`exit`, `SIGINT`, `SIGTERM`）上注册了无引用的回调函数，且缺乏退订机制。多次初始化会导致 `MaxListenersExceededWarning` 的内存泄露。同时，直接调用 `client.close()` 可能无法完全终止 `StdioClientTransport` 派生的 stdio 子进程。
3. **外部工具冲突路由覆盖**：`ToolRegistry` 在聚合外部工具时采用简单的名称哈希覆盖策略。若多个外部服务提供同名工具，会发生未定义的路由覆盖，破坏 Function Calling 的逻辑稳定性。

## 目标与非目标

**目标:**
- **彻底消除沙箱漏洞**：确保 `secureResolvePath` 的路径判定百分之百被限制在授权的工作目录及其下级子目录内，杜绝路径逃逸。
- **进程生命周期安全与解绑**：重构 MCP 子进程清理逻辑，引入幂等的 Manager 关闭接口，依次调用 `transport.close()` 与 `client.close()`；在对象关闭时主动解除 `process` 系统信号的全局监听，消除内存泄露警告。
- **工具冲突强防御阻断**：在加载外部工具元数据时增加防冲突校验，若发现不同外部 Server 提供了同名工具，直接拒绝加载并抛错提示，确保大模型路由的确切性。

**非目标:**
- 不会修改 Harness 的 ReAct 循环或上下文适配器的整体行为。
- 不会更改本地物理文件工具的功能性逻辑。
- 不会修改系统整体的 UI 或 CLI 框架。

## 架构决策

### 决策 1：基于 `path.sep` 和 `===` 的精确路径边界加固
- **理由**：使用 `resolvedPath.startsWith(authorizedDir)` 会被诸如 `authorizedDir` 的同前缀文件夹绕过。为了解决此问题，我们采用以下判断逻辑：
  ```typescript
  const isAuthorized = resolvedPath === authorizedDir || resolvedPath.startsWith(authorizedDir + path.sep);
  ```
  这使得路径安全验证可以精确到“是否完全等于根目录”或“是否是根目录下的子元素（带有标准分隔符前缀）”，从底层完全杜绝了路径同名前缀逃逸的可能性。
- **替代方案**：曾考虑使用符号链接解析或者彻底禁止使用任何相对路径，但这在开发场景中会极大地降低智能体读写复杂源码文件的灵活性，因此采用基于分隔符前缀的强匹配是最佳平衡。

### 决策 2 [Amend 修正]：McpToolManager 信号监听防漏机制与链式优雅销毁
- **理由**：为避免多次实例化全局信号监听器导致的内存泄露，我们将注册的回调抽离为具名的私有方法引用 `this.cleanupHandler`。
  - 在 `McpToolManager` 实例化时使用 `process.on` 绑定具名回调。
  - [Amend 修正]：为了防范 stdio 子进程残留与僵尸进程，在 `close()` 或 `disconnectServer()` 时，采用四步优雅销毁流程：
    1. 主动调用 `transport.close()` 关闭 stdio 传输管道的 `stdin`，给外部子进程发送 EOF 信号。
    2. 引入最多 3 秒的异步延迟，让外部服务子进程在 stdin 关闭后完成优雅自毁。
    3. 依次执行客户端关闭（`client.close()`）以断开协议连接并释放路由。
    4. 使用 `process.off` 解绑全局具名退出信号，确保 `close()` 与清理逻辑的绝对幂等性与零残留。
- **替代方案**：曾考虑直接使用 Node.js 的 `process.kill(pid)` 暴力销毁，但在 Windows 下进程树（Process Tree）销毁逻辑非常复杂，直接强杀容易留下孤立的守护进程；采用“Stdin EOF 优雅关闭 + 超时兜底”是目前 Node.js 环境下最为稳健的方案。

### 决策 3：统一工具命名冲突阻断机制
- **理由**：大模型在使用 Function Calling 时，工具名称是检索的唯一标识。如果在路由扁平化整合时允许重名工具直接覆盖，会造成严重的逻辑混淆。我们在聚合外部工具元数据时，进行显式冲突匹配，一旦冲突，直接抛出 `Error` 阻断 MCP 启动，并在终端暴露警告。
- **替代方案**：曾考虑采用 Namespace 自动重命名（如 `serverName__toolName`），但这会增加大模型调用时的理解偏差与协议不一致问题，相比之下，在初期采取强阻断与抛错更能保证系统的健壮性和明确性。

## 风险与权衡

- **跨平台路径兼容性风险**：Windows 下的 `path.sep` 为 `\`，而 Linux 为 `/`。如果模型向工具传递了 Unix 风格的斜杠参数而运行在 Windows 上，可能造成匹配失败。
  - *缓解策略*：在执行安全校验前，通过 `path.resolve` 将用户输入的混合风格斜杠统一转换为当前操作系统的原生绝对路径，从而进行无差别比对。
- **子进程优雅退出挂起**：若某些外部 MCP 服务的子进程在 stdin 关闭后无法优雅自毁。
  - *缓解策略*：在 StdioClientTransport 调用 close 时，如果 3 秒内未完全关闭，则进行捕获和错误记录，并在系统进程退出时由 OS 进行兜底清理。
