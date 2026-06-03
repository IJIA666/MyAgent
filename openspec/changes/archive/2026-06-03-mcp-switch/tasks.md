## 1. 配置层与解析层改造

- [x] 1.1 更新配置类型定义，使 `McpServerConfig`（或相关的 MCP 服务类型）增加 `enabled?: boolean` 字段。
- [x] 1.2 编写 `updateMcpServerStatus(name: string, enabled: boolean)` 函数，用于读取、修改内存状态并持久化写回 `mcp_config.json`。

<!-- checkpoint: npx tsc --noEmit -->

## 2. 动态加载与生命周期管理

- [x] 2.1 修改 `McpToolManager` 的 `connectAll()` 逻辑，使其启动时跳过 `enabled === false` 的服务。
- [x] 2.2 在 `src/action/mcp.ts` 的 `McpToolManager` 中暴露 `connectServer(name: string)` 接口，用于动态建立单一 Server 的连接，并触发注册其下属的 Tools。
- [x] 2.3 在 `McpToolManager` 暴露 `disconnectServer(name: string)` 接口，用于优雅关闭通信客户端，并清理暴露给大模型的所有对应的 Tools 签名元数据。

<!-- checkpoint: npx tsc --noEmit -->

## 3. CLI 交互层打通

- [x] 3.1 在 `src/interface/command.ts` 的分发器中新增 `/mcp` 指令。
- [x] 3.2 实现 `/mcp enable <name>` 子命令：检验服务是否存在 -> 更新持久化配置 -> 调用 `connectServer` -> 在终端打印成功的高亮日志。
- [x] 3.3 实现 `/mcp disable <name>` 子命令：检验服务是否存在 -> 更新持久化配置 -> 调用 `disconnectServer` -> 在终端打印停用成功的高亮日志。
- [x] 3.4 在 `/help` 打印菜单中添加 `/mcp enable/disable <name>` 指令的使用说明。

<!-- checkpoint: npx tsc --noEmit -->

## 4. [Amend] 状态与工具清单展示

- [x] 4.1 在 `McpToolManager` 中暴露获取当前 MCP 服务配置与连接状态的方法，供 `/mcp list` 使用。
- [x] 4.2 在 `command.ts` 实现 `/mcp list`：查询所有 MCP 配置节点，区分 enabled 状态，打印表格或高亮列表。
- [x] 4.3 在 `command.ts` 新增处理 `/tool list` 的分支。调用 `context.session.toolRegistry.getTools()` 或 `mcpManager.getMcpTools()` 打印出所有可用的工具清单。
- [x] 4.4 在 `/help` 中追加 `/mcp list` 和 `/tool list` 说明。

<!-- checkpoint: npx tsc --noEmit -->
