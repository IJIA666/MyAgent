## 1. 虚拟 MCP 抽象层开发

- [x] 1.1 在 `src/virtual-mcp.ts`（或重构 `tools.ts`）中创建 `LocalFileSystemMcpServer` 抽象类
- [x] 1.2 将原生 `readFile`、`writeFile`、`listFiles` 逻辑包裹进符合 MCP `CallTool` 规范的路由中
- [x] 1.3 确保返回值符合 MCP 的 `CallToolResult` 结构规范，例如包含 `content` 数组

<!-- checkpoint: npm run build -->

## 2. 核心引擎适配重构

- [x] 2.1 在 `src/session.ts` 中初始化 `LocalFileSystemMcpServer` 实例
- [x] 2.2 重构工具发现（Tool Discovery）逻辑，从虚拟 MCP Server 中获取所有工具签名并合并至全局可用工具列表
- [x] 2.3 修改模型回调执行逻辑（Tool Call Dispatcher），将原本的本地反射调用统一替换为调用虚拟 MCP Server 的接口

<!-- checkpoint: npm run build -->

## 3. 清理与收尾

- [x] 3.1 移除 `src/tools.ts` 中直接暴露给大模型的旧版原生工具函数
- [x] 3.2 运行完整测试/启动检查，确保文件读写功能（如读取配置文件、保存日志）依然正常开箱即用

<!-- checkpoint: npm run build -->
