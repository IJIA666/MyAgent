## 背景

MyAgent 当前的 `mcp_config.json` 采用标准 MCP 配置结构，但无内置启停功能，终端交互也无对应命令，调试及管理 MCP 插件时极度不便。我们决定采用类似主流 MCP 客户端（Claude Desktop, Cursor 等）的策略，在配置中扩展 `enabled` 布尔值，并配套新增 `/mcp` 终端命令实现热更新。

## 目标与非目标

**目标:**
- 在 `mcp_config.json` 单个服务器节点支持 `enabled?: boolean` 字段（缺省视为 true）。
- 在 `src/interface/command.ts` 暴露 `/mcp enable <name>` 和 `/mcp disable <name>`。
- 命令执行时，联动底层的 `McpToolManager` 进行服务断开或重连，并同步持久化写回 `mcp_config.json`。

**非目标:**
- 暂不实现基于 GUI 的可视化插件管理面板。
- 暂不实现 MCP 服务器的自动化环境热插拔安装（如自动 npm install 等），仅针对已有配置项的软启停。

**[Amend 修正]:**
- 增加终端交互中查阅全局连接状态及可用工具清单的需求，实现 `/mcp list` 与 `/tool list` 命令。

## 架构决策

- **配置扩展模型**: 选取内置字段方案（方案 A）。在标准 MCP 配置对象中直接侵入 `enabled` 字段。该字段与各服务原生参数天然内聚，极大简化了维护逻辑。
- **运行时动态管理 (`McpToolManager`)**: 原有设计可能是冷启动一次性连接 `connectAll()`。重构需要暴露单个服务的控制接口：`enableServer(name)`（加载配置并建立通讯，注册工具列表）和 `disableServer(name)`（主动终止连接，从注册表中销毁对应的工具元数据）。
- **交互调度层 (`command.ts`)**: 新增对 `/mcp` 指令的解析。在正确校验配置中是否存在目标服务器后，调用 `McpToolManager` 的方法，并在成功后调用文件写操作固化状态。

## 风险与权衡

- **风险**: 若 `McpToolManager` 在 disable 断开连接时清理不彻底，可能导致向大模型注入了不存在的 Tool 定义，模型调用时会引发系统级崩溃或执行失败。
- **权衡与应对**: 在反注册逻辑中，必须强制从总线（ToolRegistry 或 McpToolManager 本身的暴露列表）中剔除所有该 Server 所属的工具签名。大模型必须立刻通过上下文更新感知到工具已下线。
