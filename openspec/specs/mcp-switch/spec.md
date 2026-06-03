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
- **THEN** 终端汇总并打印出当前向大模型暴露的所有工具列表（包括名称及所属的 Server）
