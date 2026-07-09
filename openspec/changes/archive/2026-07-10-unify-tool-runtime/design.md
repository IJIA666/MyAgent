## 背景

当前仓库的本地工具运行时存在"双重装配"问题：

- `ToolRegistry`（`src/adapters/tools/toolRegistry.ts`）承担对外统一调用门面与元数据查询门面职责。
- `LocalFileSystemMcpServer`（`src/adapters/tools/virtual-mcp.ts`）内部聚合 `gitTools`、`fileSystemTools`、`systemTools`、`skillTools`、`interactionTools`、`browserTools` 为 `NativeTool[]` 数组，承担工具注册职责。
- `ToolRegistry` 构造函数内部创建 `LocalFileSystemMcpServer`，然后通过 `getAllTools()` 取出 `NativeTool[]`，再构造 `ToolCatalog`、`ToolExecutor`、`ToolAccessMetadataProvider`——重复了工具的遍历与装配。
- 真实执行主链当前是 `ToolCallOrchestrator → ToolRegistry.callTool → ToolExecutor.execute`，本地工具调用并不依赖 `LocalFileSystemMcpServer.callTool()` 这条路径。

因此，`LocalFileSystemMcpServer` 当前更像是"保留着 MCP 形状的本地兼容包装层"而非不可替代的真实执行边界。跨项目竞品调研（Claude Code、opencode、Hermes、OpenClaw）一致结论是应统一内部工具运行时模型，而非让内置工具伪装成 MCP。

## 目标与非目标

**目标：**

1. 消除本地工具的重复装配，`ToolCatalog`、`ToolExecutor`、`ToolAccessMetadataProvider` 只保留一套实例来源。
2. `ToolRegistry` 重构为统一门面：对内聚合本地工具真源，对外暴露调用入口与元数据查询入口。
3. `LocalFileSystemMcpServer` 退出"工具装配中心"角色——降为薄协议适配层（若确有调用方依赖其 MCP 入口），或直接移除。
4. 引入 `McpToolManager` 专注于外部 MCP 工具生命周期管理（发现、连接、断线恢复、调用）。

**非目标：**

1. 不改变 `ToolCallOrchestrator` 的对外调用接口——调用方不应感知本次重构。
2. 不处理组合根 `src/index.ts` 中的其他装配内联问题（如 `loadSkill` 加载路径、Embedding 适配器选择）——这些属于另一条边界，不与本次改动捆绑。
3. 不把所有内置工具改为 MCP 协议——MCP 是外部工具接入机制，不是本地工具的基础抽象。
4. 不涉及横切能力（审批、资源提取、输出裁剪）的逻辑变更——仅确保它们仍只经过一个明确边界。

## 架构决策

### 决策 1：本地工具真源归位

将本地工具的装配责任从 `LocalFileSystemMcpServer` 内聚到 `ToolRegistry` 直接管理。

- **当前状态（Avoid）**：`ToolRegistry` 构造函数内先创建 `LocalFileSystemMcpServer` 用以注册工具，再通过 `getAllTools()` 取出 `NativeTool[]` 构造 `ToolCatalog`/`ToolExecutor`。`LocalFileSystemMcpServer` 沦为一次性的注册容器，其 MCP 入口 `callTool` 未被主执行链使用。
- **目标状态（Pursue）**：`ToolRegistry` 直接持有工具列表并构造 `ToolCatalog`/`ToolExecutor`，移除对 `LocalFileSystemMcpServer` 的注册依赖。`LocalFileSystemMcpServer` 降级为可选适配层（或移除）。
- **依据**：真实执行链（`ToolCallOrchestrator → ToolRegistry.callTool`）已经绕开了 `LocalFileSystemMcpServer.callTool()`，说明两层隔离是冗余的。

### 决策 2：ToolRegistry 收缩为门面

- **调用路由**：`callTool` 先判断本地目录是否命中。若为本地工具，路由至本地 `ToolExecutor.execute`；若为外部 MCP 工具，路由至 `McpToolManager.callMcpTool`。
- **元数据查询**：本次只约束本地工具元数据边界。`getTool(name)` 仍返回本地工具的 `ToolMetadata`，`ToolAccessMetadataProvider` 仍只聚合本地工具的 `resourceExtractor` 与 `accessMetadata`。外部 MCP 工具继续通过 `getMcpTools()` 暴露工具定义，不在本次引入新的“全量元数据查询”接口。
- **替代方案**：保留两层门面让 `ToolRegistry` 委托 `LocalFileSystemMcpServer`。这维持现状，不解决重复装配问题——否决。

### 决策 3：LocalFileSystemMcpServer 降级或移除

- 如果发现任何不可迁移的外部调用方依赖 `LocalFileSystemMcpServer` 的 MCP 形状入口，则保留为薄适配层：内部委托到同一套 `ToolExecutor`，不再自行维护 `ToolCatalog`。
- 如果仅有仓库内测试依赖该入口，则应先将测试迁移到统一运行时，再移除该文件及相关引用。
- 如果不存在这样的外部调用方，则直接移除该文件及相关引用。
- **判断依据**：在明确 `ToolCallOrchestrator → ToolRegistry` 是唯一主链后，`LocalFileSystemMcpServer` 不再承担路由职责。

### 决策 4：明确 McpToolManager 的外部 MCP 职责

- `McpToolManager`（`src/adapters/tools/mcp-client.ts`）已经存在且功能完整，涵盖外部 MCP 服务器连接、工具发现（`getMcpTools` 背后的远端 `listTools`）、调用（`callMcpTool`）、断线重连。本次不改动其内部逻辑。
- 唯一调整：确认 `ToolRegistry` 持有 `McpToolManager` 引用并在 `callTool` 中按“本地目录是否命中”分发，不混入本地工具管理逻辑。

### 决策 5：依赖注入调整

组合根（`src/index.ts`）中工具装配部分做相应调整：

- 当前 `ToolRegistry` 构造函数内部创建 `LocalFileSystemMcpServer` 并从中提取工具列表，不需更改组合根传参方式。
- 将 `LocalFileSystemMcpServer` 的装配逻辑（`NativeTool[]` 聚合）提取为独立的工厂函数或工具列表常量，供 `ToolRegistry` 直接引用。
- 组合根中 `McpToolManager` 的创建和初始化时序不变。

```
// 当前（示意—ToolRegistry 内部）
constructor(mcpManager?, options?) {
  const server = new LocalFileSystemMcpServer(options);
  const allTools = server.getAllTools();
  this.catalog = new ToolCatalog(allTools, mcpManager);
  this.executor = new ToolExecutor(this.catalog);
  this.metadataProvider = new ToolAccessMetadataProvider(allTools);
}

// 目标（示意—将装配逻辑内聚到 ToolRegistry 内）
constructor(mcpManager?, options?) {
  const allTools = buildNativeTools(options);  // 统一装配点
  this.catalog = new ToolCatalog(allTools, mcpManager);
  this.executor = new ToolExecutor(this.catalog);
  this.metadataProvider = new ToolAccessMetadataProvider(allTools);
  // LocalFileSystemMcpServer 仅按需保留为适配层
}
```

## 风险与权衡

| 风险 | 缓解策略 |
|:---|:---|
| `LocalFileSystemMcpServer` 有未被发现的仓库外间接调用方，移除后造成运行时错误 | 保留降级方案：改为薄适配层而非直接删除；仓库内测试先迁移到统一运行时，再确认无外部调用后清除 |
| 横切逻辑（审批资源提取、claimCapability）的路由路径发生变化 | 架构决策 2 已确保横切逻辑捆绑在 `ToolExecutor.execute` 上，不因装配源移动而改变执行链 |
| 外部 MCP 工具与本地工具分发判断逻辑出错，导致工具路由错误 | 维持现有边界：本地工具以 `catalog.getTool(name)` 命中结果作为唯一判定标准，未命中时再回退到 `McpToolManager.callMcpTool` |
| 重构范围蔓延到组合根的其他装配职责 | 非目标已明确排除 `loadSkill`、Embedding 适配器等，代码审查时把关 |
