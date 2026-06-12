## 1. 沙箱路径绝对安全加固

- [x] 1.1 修改 `src/action/tools.ts` 中的 `secureResolvePath` 函数，替换前缀匹配逻辑，引入 `path.sep` 与精确全等校验。
- [x] 1.2 对本地文件读写操作（`readFileTool`, `writeFileTool`, `listFilesTool`）进行防御性测试以确保改动后功能无受损。

<!-- checkpoint: npm run build -->

## 2. MCP 客户端生命周期管理与内存防泄露重构

- [x] 2.1 修改 `src/action/mcp-client.ts`，将构造函数中的匿名信号监听回调提取为具名私有方法 `cleanupHandler`。
- [x] 2.2 重构 `McpToolManager.close()` 方法，使其具有 `isClosed` 状态屏障保证幂等关闭，并依次调用 `transport.close()`，添加 3 秒优雅自毁等待延迟，再调用 `client.close()`。
- [x] 2.3 在 `McpToolManager.close()` 执行完毕前，使用 `process.off` 解绑全局信号监听。
- [x] 2.4 在 `McpToolManager.disconnectServer()` 中同步补充包含 3 秒优雅等待延迟的 `transport` 和 `client` 链式断开序列。

<!-- checkpoint: npm run lint -->

## 3. 聚合工具防重名冲突阻断校验

- [x] 3.1 修改 `src/action/mcp-client.ts` 的 `getMcpTools` 方法。在遍历外部 MCP 服务工具并向 `toolRouter` 写入时，添加工具名称冲突碰撞匹配。
- [x] 3.2 当发生冲突时，通过抛出带明确错误信息的 `Error` 来阻断加载，向终端报警。
- [x] 3.3 重新编译项目并进行最终集成测试。

<!-- checkpoint: npm run build -->
