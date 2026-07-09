## 1. 提取本地工具装配为独立单元

- [x] 1.1 在 `src/adapters/tools/` 下新建 `tool-factory.ts`，将 `LocalFileSystemMcpServer` 构造函数中聚合 `NativeTool[]` 的逻辑抽取为独立导出函数 `buildNativeTools(options?)`，保留原有工具注册顺序（git → filesystem → system → skill → interaction → browser）不变
- [x] 1.2 在 `tool-factory.ts` 中为 `buildNativeTools` 添加 TSDoc，标明返回值是所有领域工具实例的扁平数组
- [x] 1.3 验证 `tool-factory.ts` 不引入 `LocalFileSystemMcpServer` 类的依赖，保持纯工具列表组装职责

<!-- checkpoint: npx tsc --noEmit -->

## 2. 重构 ToolRegistry 构造函数

- [x] 2.1 修改 `ToolRegistry` 构造函数：用 `buildNativeTools(options)` 替换 `new LocalFileSystemMcpServer(options)` → `getAllTools()` 的调用链
- [x] 2.2 保留 `ToolCatalog`、`ToolExecutor`、`ToolAccessMetadataProvider` 的构造逻辑不变——仅改变 `allTools` 的来源
- [x] 2.3 确认 `ToolRegistry` 中 `callTool` 方法的本地/外部路由逻辑不受影响（`catalog.getTool(name)` 判断本地工具的逻辑使用同一份 `ToolCatalog` 实例）
- [x] 2.4 移除 `ToolRegistry` 构造函数中对 `LocalFileSystemMcpServer` 实例的引用和存储

<!-- checkpoint: npx tsc --noEmit -->

## 3. 处理 LocalFileSystemMcpServer 降级或移除

- [x] 3.1 全局搜索 `LocalFileSystemMcpServer`（含 `virtual-mcp`）的所有引用点和 import，确认是否存有调用 `callTool` 或直接依赖其 MCP 协议入口的真实调用方
- [x] 3.2 若不存在不可迁移的外部调用方：移除 `virtual-mcp.ts` 文件及所有 import 引用；若仅有仓库内测试依赖，则先迁移测试到统一运行时后再移除；若存在外部调用方，则将其改造为薄适配层，内部委托到 `ToolExecutor` 实例
- [x] 3.3 检查 `src/index.ts` 组合根中是否有对 `LocalFileSystemMcpServer` 的直接引用，如有则同步清理
- [x] 3.4 检查 `NativeTool` 接口是否仍被其他模块直接引用（若 `virtual-mcp.ts` 被移除，需要将 `NativeTool` 接口迁移到独立文件或 `tool-factory.ts`）

<!-- checkpoint: npx tsc --noEmit -->

## 4. 验证横切逻辑与路由不变

- [x] 4.1 确认 `ToolRegistry.callTool` 中 `isLocalTool = catalog.getTool(functionName) !== undefined` 的判断逻辑仍使用 `ToolCatalog` 实例——这是本地/MCP 路由的唯一判定标准
- [x] 4.2 确认 `ToolExecutor.execute` 中的审批流程（`claimCapability`）、安全检查（`enforceDangerCheck`）、输出格式化顺序不受代码移动影响
- [x] 4.3 确认 `ToolAccessMetadataProvider` 的 `resourceExtractor` 和 `accessMetadata` 聚合逻辑不变

<!-- checkpoint: npx tsc --noEmit -->

## 5. 全局清理与最终验证

- [x] 5.1 重新审视所有涉及工具装配的 import 链，移除 `LocalFileSystemMcpServer` 相关的已废弃 import
- [x] 5.2 执行完整编译检查，确认无类型错误、无未解析的模块引用
- [x] 5.3 检查 `src/adapters/tools/tools.ts`（旧式导出入口）是否需要同步调整

<!-- checkpoint: npx tsc --noEmit -->
