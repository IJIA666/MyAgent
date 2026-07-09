## 新增需求

### 需求: 工具目录聚合查询

`ToolCatalog` 必须（MUST）聚合本地内建工具与外部 MCP 工具的完整定义列表，供大语言模型函数调用注册使用。

#### 场景: 查询包含全部内建工具

- **WHEN** 调用 `ToolCatalog.getTools()` 且无外部 MCP 工具挂载
- **THEN** 返回包含全部本地内建工具定义的数组，格式与当前 `getTools()` 输出一致

#### 场景: 合并外部 MCP 工具

- **WHEN** 调用 `ToolCatalog.getTools()` 且存在已连接的外部 MCP 工具管理器
- **THEN** 返回的数组包含本地工具定义与外部 MCP 工具定义的并集

#### 场景: 按名称查询单个工具元数据

- **WHEN** 调用 `ToolCatalog.getTool(name)` 查询已注册的工具
- **THEN** 返回该工具的 `ToolMetadata` 对象，包含 `name`、`securityCategory` 等信息

#### 场景: 查询未注册工具返回 undefined

- **WHEN** 调用 `ToolCatalog.getTool(name)` 查询不存在的工具
- **THEN** 返回 `undefined`

### 需求: 工具模块独立注册

各工具模块应（SHALL）提供独立的工具注册清单，新增工具类型无需修改 `ToolCatalog` 或 `virtual-mcp.ts`。

#### 场景: 文件工具模块提供注册清单

- **WHEN** `ToolCatalog` 初始化时加载 `filesystem` 模块的注册清单
- **THEN** 该清单返回的文件工具实例均被纳入目录

#### 场景: 浏览器工具模块提供注册清单

- **WHEN** `ToolCatalog` 初始化时加载 `browser` 模块的注册清单
- **THEN** 浏览器工具实例不再在 `virtual-mcp.ts` 中直接构造
