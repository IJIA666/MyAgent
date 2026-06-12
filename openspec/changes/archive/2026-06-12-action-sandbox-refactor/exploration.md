# 探索主题: 动作执行与工具沙箱子系统评估与重构建议

## 1. 问题定义
随着智能体底座的初步成型，其与本地文件系统的交互以及外部 Model Context Protocol (MCP) 服务的集成已成为核心能力。然而，当前在“文件沙箱越界校验”、“外部 MCP 进程生命周期管理”以及“工具重名冲突防范”上存在明显的安全漏洞与稳定性风险。本探索旨在评估其架构和代码质量，并提供切实可行的重构方案。

## 2. 关键发现与调研结果
- **代码库现状**：
  - **路径沙箱校验漏洞**：在 [tools.ts](file:///d:/Projects/MyAgent/src/action/tools.ts) 的 `secureResolvePath` 中，使用了 `resolvedPath.startsWith(authorizedDir)` 来防御路径遍历。当 `authorizedDir` 为 `/authorized/path`，而用户输入被解析为 `/authorized/path-secret` 时，该校验会通过，从而允许访问不属于授权目录的文件夹。
  - **子进程生命周期隐患**：在 [mcp-client.ts](file:///d:/Projects/MyAgent/src/action/mcp-client.ts) 中，`McpToolManager` 仅在 `process` 的 `exit`、`SIGINT` 和 `SIGTERM` 信号上绑定了回调。如果 `McpToolManager` 被多次实例化（如在热重载或测试中），将导致 `MaxListenersExceededWarning`，且调用 `client.close()` 后未解除监听，存在内存泄露风险。此外，未显式调用 `transport.close()`，可能导致 stdio 子进程无法被完全回收而成为僵尸进程。
  - **外部工具重名覆盖**：在 [mcp-client.ts](file:///d:/Projects/MyAgent/src/action/mcp-client.ts) 的 `getMcpTools` 中，路由表采用扁平的 `toolRouter.set(tool.name, serverName)` 结构。若两个外部 MCP 服务提供了同名工具，后连接的服务将直接覆盖前者的路由，导致大模型调用时发生严重的路由错乱。

- **核实与洞察**：
  - 经联网搜索核实，防范 Node.js 路径遍历的工业级最佳实践是在 `startsWith` 判断时加上 `path.sep`（即 `authorizedDir + path.sep`），并额外允许精确相等的路径（`resolvedPath === authorizedDir`），以杜绝同前缀的目录越界逃逸。
  - MCP JS SDK 官方 issue 与实践表明，`client.close()` 不一定能优雅关闭 `stdio` 传输层子进程。正确顺序为先调用 `await transport.close()` 断开 stdin 管道以触发子进程自毁，再调用 `await client.close()`。

## 3. 方案对比与推荐方向

### 3.1 沙箱路径校验方案对比
| 评估维度 | 方案 A：只用 `startsWith` (当前方案) | 方案 B：加 `path.sep` 与相等判断 (推荐) | 方案 C：基于 Hash 的虚拟文件系统映射 |
| :--- | :--- | :--- | :--- |
| **安全性** | 存在越界漏洞 ✗ | 绝对隔离安全 ✓ | 绝对安全 ✓ |
| **可用性** | 正常使用 ✓ | 正常使用 ✓ | 模型无法理解真实物理文件树 ✗ |
| **开发成本**| 无成本 | 极低 ✓ | 极高 |

**结论**：方案 B 占优。通过在边界前缀判定中包含系统分隔符，完全堵塞了同前缀目录逃逸的漏洞，且不需要改变大模型与真实文件的交互模式。

### 3.2 MCP 进程生命周期与清理方案对比
| 评估维度 | 方案 A：全局信号直接 close 客户端 (当前方案) | 方案 B：幂等清理 + 链式 Close + 动态解绑 (推荐) |
| :--- | :--- | :--- |
| **子进程回收成功率** | 较低（易产生僵尸进程） ✗ | 极高（先关 stdin，后关 client） ✓ |
| **内存泄露与警告** | 多次实例化触发 MaxListeners 警告 ✗ | 零泄露，解绑全局监听 ✓ |
| **开发成本** | 无 | 中等 |

**结论**：方案 B 占优。链式销毁可以确保底层的进程资源彻底回收，而动态解绑系统信号避免了高频重载下的内存溢出隐患。

### 3.3 工具冲突处理方案对比
| 评估维度 | 方案 A：扁平覆盖 (当前方案) | 方案 B：抛错阻断 (强防御) | 方案 C：命名空间自动重整 (灵活推荐) |
| :--- | :--- | :--- | :--- |
| **稳定性** | 极低（模型调用错乱） ✗ | 正常（防止错乱，但可用性降级） | 极高（防止错乱，保留全部能力） ✓ |
| **实现成本**| 无 | 极低 ✓ | 中等 |
| **易用性** | 差 | 一般 | 优（模型可按 Server 名称调用） ✓ |

**结论**：在初期阶段，采用方案 B（发现重名工具冲突时抛出异常阻断加载并警告）性价比较高，可强力防范安全与语义边界被污染；未来进阶演进时可支持方案 C。

**推荐路径**：
1. **立即重构沙箱路径安全判定**，添加系统路径分隔符校验以封堵路径穿透漏洞。
2. **优化进程管理**，引入幂等 `close()`，依次调用 `transport.close()` 与 `client.close()`，并在释放时显式使用 `process.off()` 解绑全局进程信号。
3. **增加工具注册防重名冲突校验**，在 `getMcpTools` 与 `ToolRegistry` 中发现重名工具时直接拒绝加载并警告。

## 4. 约束、风险与未知项
- **环境兼容性风险**：在 Windows 下，`path.sep` 为 `\`，而在 Linux/macOS 下为 `/`。对于在 Windows 环境下运行、而由模型传入 Unix 风格路径参数的情况，需利用 `path.resolve` 或 `path.normalize` 进行统一的跨平台标准化消除，防止大小写或斜杠类型造成的判定绕过。
- **外部进程阻塞未知项**：如果外部 MCP Server 的子进程在 stdin 关闭后挂起且不自毁，`transport.close()` 仍可能无法回收它。这需要设定一个超时保护，超时后在 Node.js 中执行物理 `kill`。

## 5. 否决方案
- **直接使用 OS 命令执行沙箱隔离**：否决。在 Node.js 应用层使用硬编码的命令行执行沙箱（如 Docker 动态容器）成本过高，不利于当前以极简轻量级底座为定位的开发模式。路径安全与进程隔离应优先在 Node.js 代码逻辑内解决。
