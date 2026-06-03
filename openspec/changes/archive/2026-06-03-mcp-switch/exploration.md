# 探索主题: MCP 配置开关功能 (MCP Config Enable/Disable Switch)

## 1. 问题定义
目前 MyAgent 的 `mcp_config.json` 缺少统一的服务开关机制（若要禁用只能物理删除节点或重命名），同时终端交互也缺少快捷控制启停的指令，这不利于动态控制外部 MCP 服务的加载与调试，降低了配置的灵活性。

## 2. 关键发现与调研结果
- **现有逻辑**：MyAgent 目前的 `mcp_config.json` 完全采用了标准 MCP 协议结构（包含 `command`, `args`, `env`），但并未包含任何用于控制服务启停的字段。
- **核心洞察**：
  1. 经调研底层架构资料库，发现 `Tinypace AI Desktop`、`Hermes Agent` 及 `OpenClaw` 均在底层配置架构中原生植入了控制启停的标志位（如 `enabled: boolean`）。
  2. 经全网最新技术检索，业界主流的 MCP 客户端（如 Claude Desktop 和 Cursor IDE）均已将外挂在标准配置上的 `"enabled": false` 视作**事实标准 (De-facto Standard)**，以实现无痛的热插拔和调试切换，而不再拘泥于绝对纯洁的官方 Schema。

## 3. 方案对比与推荐方向
| 方案 | 优点 | 缺点 | 结论 |
| :--- | :--- | :--- | :--- |
| **方案 A: 内置标志位 (内置 `enabled: boolean`)** | 状态高度内聚，单个服务器的参数和开关均在同一层级，易于配置反序列化、状态展示及 GUI 扩展，且与主流生态（Cursor/Claude）兼容性一致。 | 对纯标准 MCP JSON 结构进行了微量字段拓展。 | **胜出**。已成为业界的普遍做法，体验最佳。 |
| **方案 B: 外挂黑名单 (如 `disabledMcpServers: []`)** | 彻底不侵入原生 MCP 配置协议结构。 | 启停状态与连接配置物理分离，跨文件或跨层级修改时极易产生数据不一致（如改了 server 名字导致黑名单失效）。 | 仅适合特定 CLI 工具 (如 Claude Code)。 |

**推荐路径**：
1. **持久化模型**：采纳 **方案 A**。在 `mcp_config.json` 中的各 `mcpServers` 子节点层直接扩展 `enabled?: boolean`（默认为 `true`，如果没有配默认启用）。这不仅利于后续管理，且已在多个生产级工具中被证明是最高效的。
2. **交互层指令**：在 `interface/command.ts` 中新增 `/mcp` 系统指令，支持 `/mcp enable <name>` 与 `/mcp disable <name>` 语法。执行时需实时修改内存状态、持久化回写 `mcp_config.json` 文件，并触发底层 MCP 连接状态的热更新。

## 4. 约束、风险与未知项
- **配置序列化兼容性**：当 MyAgent 将配置对象传递给底层的标准 MCP Client SDK 初始化时，需要确保底层的 SDK 不会因为多出了一个非标准的 `enabled` 字段而抛出 Schema 校验异常。必要时需在适配层执行属性剔除。

## 5. 否决方案
- **外置禁用列表（方案 B）**：因其状态与属性严重割裂，在服务配置变更时维护成本过高，予以否决。
