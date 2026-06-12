# mcp-switch

## Purpose
本模块负责支持 MCP（Model Context Protocol）扩展服务的动态启停管理，支持从配置文件中读取服务的启用状态，并提供命令行指令供用户在运行时即时挂载或卸载 MCP 扩展能力，以规避无效或冗余工具引发的大模型幻觉调用。

## Requirements

### Requirement: 配置文件扩展 enabled 开关
系统必须在读取 `mcp_config.json` 时支持并解析 `mcpServers` 各子节点中的 `enabled?: boolean` 字段。若不存在该字段，则默认视为 `true`。

#### Scenario: 加载含 enabled=false 的配置
- **WHEN** 解析 `mcp_config.json` 遇到 `enabled: false` 的服务时
- **THEN** 系统在初次加载和初始化 `McpToolManager` 时不得挂载、连接该服务

#### Scenario: 加载无 enabled 字段的配置
- **WHEN** 解析 `mcp_config.json` 遇到未声明 `enabled` 字段的节点时
- **THEN** 系统默认其为 `true` 并正常建立连接

### Requirement: 交互层增加 /mcp 指令
终端命令行必须支持 `/mcp enable <server_name>` 和 `/mcp disable <server_name>`。

#### Scenario: 动态启动服务
- **WHEN** 用户输入 `/mcp enable tavily` 且配置中存在 tavily 节点时
- **THEN** `McpToolManager` 必须动态建立连接，将配置回写为 `"enabled": true`，并在控制台给出成功提示

#### Scenario: 动态关闭服务
- **WHEN** 用户输入 `/mcp disable tavily` 且配置中存在该节点时
- **THEN** `McpToolManager` 必须销毁连接，反注册该服务挂载的所有工具，并将配置回写为 `"enabled": false`，给出成功提示

### Requirement: 增加列表查看指令 /mcp list 和 /tool list
系统必须提供指令以方便用户查看当前 MCP 的状态及可用工具清单。

#### Scenario: 查看 MCP 状态列表
- **WHEN** 用户输入 `/mcp list`
- **THEN** 终端打印出所有配置中的 MCP 服务列表，并明确标识其当前的状态（已启用且已连接、已停用等）

#### Scenario: 查看可用工具列表
- **WHEN** 用户输入 `/tool list`
- **THEN** 终端汇总并打印出当前向大模型暴露的所有工具列表（包括名称及所属 the Server）

### Requirement: MCP 服务生命周期与优雅销毁
系统必须（MUST）对挂载的外部 Model Context Protocol (MCP) 服务子进程进行幂等的生命周期管理与优雅关闭。在关闭连接时，必须（MUST）先切断传输管道（`transport.close()`）以向子进程发出退出信号，继而执行客户端关闭（`client.close()`），且在清理完毕后必须（MUST）显式解绑在全局 `process` 系统信号上挂载的所有回调监听函数，保障资源彻底回收。

#### Scenario: 优雅关闭外部 MCP 子进程与信号解绑
- **WHEN** 系统执行退出、接收到 `SIGINT`/`SIGTERM` 中断信号，或用户在终端调用了停用服务指令 `/mcp disable`
- **THEN** 系统的 MCP 管理器必须以幂等方式，优先关闭该服务的传输管道，随后等待最高 3 秒以给子进程响应 stdin EOF 退出的缓冲时间，再依次执行客户端关闭并使用 `process.off` 解除宿主进程上专门绑定的信号监听器。

### Requirement: MCP 工具注册防重名路由冲突
系统在聚合外部 MCP 服务元数据时，必须（MUST）对所有挂载工具的名称进行唯一性防冲突判定，防止大模型调用时发生路由覆盖导致行为失控。

#### Scenario: 检测到同名工具冲突时阻断加载
- **WHEN** 系统启动或动态加载 MCP 服务，获取到的工具列表里存在同名工具（如两个服务均包含名为 `fetch_web` 的工具）
- **THEN** 系统必须立即拦截该服务的挂载过程，拒绝运行，并在控制台中抛出明确的冲突工具与服务名称的异常信息以警告用户。
