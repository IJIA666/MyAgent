/**
 * Action 模块门面（Facade）。
 * 集中导出所有执行层相关的基建工具、MCP 客户端通信库与核心工具注册表。
 */
export * from './tools.js';
export * from './toolRegistry.js';
export * from './mcp-client.js';
export * from './builtin-tool-policy-adapter.js';
export * from './external-tool-policy-adapter.js';
export * from './tool-policy-router.js';
