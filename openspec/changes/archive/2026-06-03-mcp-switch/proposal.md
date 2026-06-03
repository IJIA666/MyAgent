## 改造原因

目前 MyAgent 的 `mcp_config.json` 缺少统一的服务开关机制（若要禁用只能物理删除节点或重命名），同时终端交互也缺少快捷控制启停的指令，这不利于动态控制外部 MCP 服务的加载与调试，降低了配置的灵活性。

## 变更内容

- 在 `mcp_config.json` 中各个 `mcpServers` 的配置节点直接支持 `enabled?: boolean` 标志位（默认视为 true）。
- 在 `src/interface/command.ts` 中新增系统级命令 `/mcp enable <name>`、`/mcp disable <name>` 以及 `/mcp list`。
- 新增 `/tool list` 命令，用于总览当前所有挂载的扩展工具。
- 执行启停命令时，将动态热更新底层工具挂载状态，并将开关状态持久化回写至配置文件。

## 业务能力

### 新增业务能力
- `mcp-switch`: 提供在配置文件级别及 CLI 终端交互层面启停外部 MCP 服务的控制能力。

### 修改业务能力
- （无）

## 影响范围

- `mcp_config.json`（非标准协议字段的兼容处理）
- `src/interface/command.ts`（增加系统指令）
- `src/action/mcp.ts` 或相关服务管理层（需支持运行时的动态连接与断开重载机制）
