## 1. 基础设施迁移

- [x] 1.1 创建 `src/action/` 目录
- [x] 1.2 将 `src/virtual-mcp.ts` 移动到 `src/action/virtual-mcp.ts`
- [x] 1.3 将 `src/mcp-client.ts` 移动到 `src/action/mcp-client.ts`
- [x] 1.4 将 `src/tools.ts` 移动到 `src/action/tools.ts`
- [x] 1.5 将 `src/toolRegistry.ts` 移动到 `src/action/toolRegistry.ts`

<!-- checkpoint: node -e "require('fs').existsSync('src/action/mcp-client.ts') ? process.exit(0) : process.exit(1)" -->

## 2. 门面封装与依赖修复

- [x] 2.1 创建 `src/action/index.ts`，统一重新导出上述迁移文件的所有接口、类与函数
- [x] 2.2 更新内部相对依赖，修复 `src/action/virtual-mcp.ts` 中对 `mcp-client.js` 等同层模块的导入路径
- [x] 2.3 修复外层依赖，更新 `src/session.ts` 中对行动层的导入，指向 `src/action/index.js`
- [x] 2.4 修复外层依赖，更新 `src/index.ts` 中对 `McpToolManager` 与 `initWorkspace` 的导入，指向 `src/action/index.js`
- [x] 2.5 修复外层依赖，更新 `src/command.ts` 中对 `McpToolManager` 的导入，指向 `src/action/index.js`

<!-- checkpoint: npx tsc --noEmit -->
