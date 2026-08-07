## 改造原因

阶段 2a 已交付配置型子代理骨架（`.md` 定义加载、Explore/Plan、模型解析），但定义 frontmatter 的 `mcpServers` 字段仍处于"解析但忽略"状态（`DEFERRED_FIELDS`），`--agent` 会话模式完全不存在。两个行为缺口与官方不等价：

1. **子代理无法使用专属 MCP 服务器**：官方支持定义级 `mcpServers`（字符串引用共享父连接 / 内联定义动态建连、子代理结束关闭），MyAgent 的 `McpToolManager` 只能连接全局配置清单内的服务，子代理工具面（fresh 模式）也看不到任何 MCP 工具。
2. **`--agent <type>` 缺失**：官方支持以子代理定义作为主会话启动（system prompt 替换、tools 裁剪、model 覆盖、initialPrompt 前置），MyAgent 无任何 CLI 参数解析（`process.argv` 零命中），无法以定义启动主会话。

**范围边界**（与用户确认）：hooks 移出本 change（MyAgent 无命令型 hooks 基础设施，子代理结束通知已由 task_update/task-notification 覆盖；命令型 hooks 独立立项）。子代理记忆不在本 change（留待评估）。

## 变更内容

- **子代理专属 MCP（`mcpServers` 字段启用）**：
  - 采用**每个子代理任务独立的 MCP 作用域句柄**（`AgentMcpScope`，对齐官方 per-call 保存连接句柄语义），而非共享 manager + 按名索引的动态表——解决并发同名内联服务器冲突、动态工具执行路由、清理归属三类问题。
  - 字符串引用：从全局 `McpConfig` 清单按名查配置，**共享父会话连接**（borrowed 身份），子代理结束不关闭；取消引用型调用只取消请求、不销毁物理连接。
  - 内联定义：按定义配置在 scope 内**动态建连**（owned 身份，与全局同名服务器互不干扰），子代理结束（正常/失败/取消）在 `finally` 中关闭 scope 全部内联连接并回收子进程。
  - 工具面：fresh 子代理默认可见父会话 MCP 工具（2a 既有契约，`ToolCatalog` 为 MCP 工具签发 `freshForeground: true`，与官方一致）；声明 `mcpServers` 的子代理在父 MCP 工具基础上附加其声明服务器工具；动态工具经 scope 完成枚举、descriptor 与执行路由，不进入全局路由（不污染父会话）；与已挂载工具重名时 fail-closed。
- **`--agent <type>` 会话模式**：
  - CLI argv 解析（新增最小参数解析：`--agent <type>`）。
  - 主线程装配：system prompt 为**组合语义**（MyAgent 基础人设 `BASE_SYSTEM_PROMPT` + 定义正文，经 `SessionContext` 持久附加位实现，RuleManager 重载不覆盖——**有意差异**：MyAgent 基础人设含安全指令红线，替换会丢失安全基线，故保留组合；与官方"替换默认 prompt"不等价，在规范中明示）、model 覆盖（非 `inherit` 时）、`tools`/`disallowedTools` 裁剪主线程工具面（省略或 `['*']` 时含 `Agent`；显式名单只含名单工具，写入 `Agent` 才保留——对齐官方 `agentToolUtils` 名单语义，不强制保留）、`initialPrompt` 作为首轮前缀与首条真实用户输入合并（对齐官方 main.tsx 拼接语义，不提前插入独立消息）。
  - 与官方一致**不生效**：定义级 `permissionMode`/`hooks`/`mcpServers`/`maxTurns`/`background`（主线程不消费）。
  - 未知类型：提示并回退默认行为（官方 warn 语义）。

## 业务能力

### 新增业务能力
- `subagent-agent-mcp`: 子代理定义级 `mcpServers` 的引用/内联连接语义、生命周期（只关内联新建）与工具面合并。
- `agent-session-mode`: `--agent <type>` 主会话启动模式（argv 解析、定义装配、工具裁剪、model 覆盖、initialPrompt 前置）。

### 修改业务能力
- `subagent-execution`: `SubagentDefinition` 增加 `mcpServers` 字段；协调器提交点透传；运行器 MCP 生命周期管理。
- `configured-subagent-definitions`: `mcpServers` 从"解析忽略"转为"解析生效"（类型校验、非法拒绝）。

## 影响范围

- **子代理 MCP**：`src/ports/driven/tools/McpManagerPort.ts`（新增 `AgentMcpScope` 接口与打开入口）、`src/adapters/tools/mcp-client.ts`（scope 实现：per-task 内联连接、owned/borrowed 调用、close 幂等与总清理接入）、`ScopedToolRegistry.ts`（scope 工具枚举/descriptor/执行旁路 + 统一权限网关）、`SubagentRuntime.ts`（scope 打开与 finally 关闭）、`SubagentCoordinator.ts`（提交点声明透传）、`callMcpTool` abort 语义（borrowed 不销毁物理连接）。
- **--agent**：`src/index.ts`（argv 解析）、`src/core/usecases/engine/session.ts`（主线程装配：system prompt 持久附加位/model/tools 名单/initialPrompt 前缀）、`src/core/domain/context.ts`（`setAgentSystemPrompt` 与组装集成）、`model-request-assembler.ts`（主线程工具名单过滤）。
- **定义层**：`AgentDefinitionLoader.ts`（mcpServers 与 initialPrompt 解析启用）、`SubagentDefinitionRegistry.ts`（字段类型）。
- **依赖**：无新增第三方依赖（复用既有 McpToolManager 与 McpConfig）。
