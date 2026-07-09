## 新增需求

### Requirement: 本地工具唯一装配源
系统必须（MUST）确保 `ToolCatalog`、`ToolExecutor`、`ToolAccessMetadataProvider` 三者在本地工具范围内仅存在一套实例来源，不得出现两套独立装配路径。

#### Scenario: ToolRegistry 直接使用唯一装配源
- **WHEN** 系统完成初始化并构建本地工具运行时
- **THEN** `ToolRegistry` 必须（MUST）直接基于同一批本地工具实例构造 `ToolCatalog`、`ToolExecutor`、`ToolAccessMetadataProvider`，不得先通过 `LocalFileSystemMcpServer` 注册再二次提取同一批工具。

#### Scenario: 新增本地工具后统一可见
- **WHEN** 开发者将一个新的本地工具加入本地工具装配清单
- **THEN** 该工具必须（MUST）同时被 `ToolRegistry.getTools()` 暴露、被 `ToolRegistry.getTool(name)` 返回本地元数据，并可通过 `ToolRegistry.callTool` 正常执行，不得因双重装配遗漏任一入口。

---

### Requirement: 本地工具调用绕过 virtual-mcp 装配中心
系统必须（MUST）确保本地工具主执行链不再依赖 `LocalFileSystemMcpServer` 作为装配中心或调用路由中心。

#### Scenario: 本地工具调用直接走 ToolExecutor
- **WHEN** `ToolCallOrchestrator` 通过 `ToolRegistry.callTool` 调用一个已注册的本地工具
- **THEN** `ToolRegistry` 必须（MUST）直接将请求路由到本地 `ToolExecutor.execute`，不得再通过 `LocalFileSystemMcpServer.callTool()` 进入执行链。

#### Scenario: virtual-mcp 若保留则仅为薄适配层
- **WHEN** 仓库仍保留 `LocalFileSystemMcpServer`
- **THEN** 该类必须（MUST）只充当 MCP 形状适配层，内部目录与执行逻辑必须委托统一的本地工具运行时，不得自行维护独立的 `ToolCatalog` 与 `ToolExecutor` 实例来源。

---

### Requirement: 外部 MCP 工具继续通过 McpToolManager 边界接入
系统必须（MUST）保持外部 MCP 工具与本地工具的执行边界分离：本地工具由本地运行时执行，外部 MCP 工具继续通过 `McpToolManager` 调用。

#### Scenario: 未命中本地目录时回退到外部 MCP
- **WHEN** `ToolRegistry.callTool` 收到一个未在本地 `ToolCatalog` 中命中的工具调用，且系统已配置 `McpToolManager`
- **THEN** `ToolRegistry` 必须（MUST）将该调用分发给 `McpToolManager.callMcpTool`，而不是尝试通过任何本地 virtual-mcp 包装层解析该工具。
