## 1. 端口与契约定义

- [x] 1.1 新建 [ToolAccessMetadataPort.ts](src/ports/driven/tools/ToolAccessMetadataPort.ts)，定义 `getResourceExtractor(toolName)` 和 `getAccessMetadata(toolName)` 方法签名
- [x] 1.2 扩展 [virtual-mcp.ts](src/adapters/tools/virtual-mcp.ts) 中的 `NativeTool` 接口，新增可选字段 `resourceExtractor?: (args: Record<string, unknown>, cwd: string) => SafetyResource[]` 和 `accessMetadata?: ToolAccessMetadata`
- [x] 1.3 新建 [ToolAccessMetadataProvider.ts](src/adapters/tools/ToolAccessMetadataProvider.ts) 骨架类，实现 `ToolAccessMetadataPort`，内部维护工具名到元数据的映射

<!-- checkpoint: npm run build -->

## 2. ToolCatalog 工具目录提取

- [x] 2.1 新建 [ToolCatalog.ts](src/adapters/tools/ToolCatalog.ts)，负责聚合本地内建工具与外部 MCP 工具的定义列表
- [x] 2.2 将 `ToolRegistry.getTools()` 和 `ToolRegistry.getTool()` 的目录逻辑委托给 `ToolCatalog`
- [x] 2.3 新建 [browser-tool-registry.ts](src/adapters/tools/impl/browser/browser-tool-registry.ts)，导出浏览器工具注册清单函数
- [x] 2.4 将 `virtual-mcp.ts` 构造函数中浏览器工具的 9 个 import 与构造逻辑迁移到 `browser-tool-registry.ts`
- [x] 2.5 各工具模块（filesystem/system/skill/interaction/git）确认其 `index.ts` 导出的工具清单可被 `ToolCatalog` 直接聚合

<!-- checkpoint: npm run build -->

## 3. 元数据去中心化

- [x] 3.1 将 `registerExtractorsForBuiltinTools()` 中按工具名分支的提取逻辑，逐工具迁移到对应 `NativeTool` 定义的 `resourceExtractor` 字段
- [x] 3.2 实现 `ToolAccessMetadataProvider` 的元数据聚合逻辑：初始化时遍历所有已注册工具的 `resourceExtractor` 和 `accessMetadata`
- [x] 3.3 优先迁移文件操作工具（filesystem/）的 `resourceExtractor`
- [x] 3.4 迁移系统工具（system/）和浏览器工具（browser/）的 `resourceExtractor`
- [x] 3.5 更新 `ToolRegistry` 构造函数，注入 `ToolAccessMetadataProvider` 实例

<!-- checkpoint: npm run build -->

## 4. ToolExecutor 执行调度

- [x] 4.1 新建 [ToolExecutor.ts](src/adapters/tools/ToolExecutor.ts)，实现 `execute(toolName, args, context)` 核心方法
- [x] 4.2 将 `virtual-mcp.ts` 中 `tools/call` 的执行逻辑（能力认领 → 工具执行 → 结果包装）迁移到 `ToolExecutor.execute()`
- [x] 4.3 保持能力认领（`claimCapability`）和令牌消费（`consumeCapability`）的整体时序不变；若 `consumeCapability` 继续留在 `agent-loop` 外层 finally，则本 change 不强行迁入 `ToolExecutor`
- [x] 4.4 `ToolRegistry.callTool()` 内部委托给 `ToolExecutor.execute()`

<!-- checkpoint: npm test -->

## 5. virtual-mcp.ts 收缩

- [x] 5.1 重构 `LocalFileSystemMcpServer` 构造函数：接收 `ToolCatalog` 和 `ToolExecutor` 实例，不再直接 import 和实例化工具实现
- [x] 5.2 MCP `tools/list` 处理委托给 `ToolCatalog.getTools()`
- [x] 5.3 MCP `tools/call` 处理委托给 `ToolExecutor.execute()`
- [x] 5.4 移除 `virtual-mcp.ts` 中对浏览器工具类和 `registerExtractorsForBuiltinTools()` 的直接 import

<!-- checkpoint: npm run build -->

## 6. 核心层强转依赖消除

- [x] 6.1 检查 [session.ts](src/core/usecases/engine/session.ts) 中将 `toolRegistry` 强转为 `ToolRegistry` 的调用点，改为通过 `ToolAccessMetadataPort` 获取资源提取器
- [x] 6.2 检查 [agent-loop.ts](src/core/usecases/engine/agent-loop.ts) 中工具相关调用，确认无需新增强转或额外适配
- [x] 6.3 更新依赖注入链：`ToolAccessMetadataProvider` 注入 `SessionManager`

<!-- checkpoint: npm run build -->

## 7. 清理与收尾

- [x] 7.1 移除 `virtual-mcp.ts` 中的 `registerExtractorsForBuiltinTools()` 函数
- [x] 7.2 移除 `virtual-mcp.ts` 中不再需要的 import（浏览器工具类、集中式提取器相关）
- [x] 7.3 移除 `ToolRegistry` 中已迁移到 `ToolCatalog`/`ToolExecutor` 的内部实现
- [x] 7.4 全量编译 + 全量单测回归，确认工具执行链路无破坏

<!-- checkpoint: npm run build && npm test -->
