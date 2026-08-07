## 背景

阶段 2a 交付了配置型子代理骨架（`.md` 定义加载、统一注册表、提交点字段消费、运行器透传）。`mcpServers` 与 `initialPrompt` 字段未生效，`--agent` 会话模式不存在（MyAgent 无 CLI 参数解析）。

已核实的现状事实（含评审修正）：

- **MCP 工具对 fresh 子代理默认可见**：`ToolCatalog.ts:113-122` 为 MCP 工具签发 `subagentToolPolicy.freshForeground: true`（descriptor 推导）——2a 实际基线是 fresh 可见父 MCP（执行仍走权限链），与官方一致。
- **Abort 会销毁物理连接**：`mcp-client.ts:324-337` 的 `callMcpTool` 监听 AbortSignal，触发时无条件 `disconnectServer(serverName)` 强制关闭连接——取消引用型调用会误伤父会话共享连接。
- **全局路由不可执行动态工具**：`McpToolManager.getMcpTools()` 遍历全局 `connections` 重建 `toolRouter`；`ToolRegistry.callTool` 查全局 descriptor/路由执行 MCP。动态工具若不进全局路由则"可见不可调"，进则污染父会话。
- **system prompt 组装恒含基础人设**：`prompts.ts:149` 的 `buildSystemPrompt` 恒含 `BASE_SYSTEM_PROMPT`（stable 层）——`updateSystemPrompt` 是组合语义而非替换；`RuleManager` 技能变更时会再次改写 system。
- **官方基准**：内联连接按 per-call 句柄保存与清理（`runAgent.ts:129/197-210`，非按服务器逻辑名）；`--agent` 主线程工具名单语义为"省略或 `['*']` 全量、显式名单只含名单工具"（`agentToolUtils.ts:140-165`）；`initialPrompt` 与首条输入同消息拼接（`main.tsx:2091`）。
- `SessionManager.switchModel(newConfig)` 已存在（`session.ts:561`）；`model-request-assembler` 已有请求期工具过滤先例（plan 剥离）。

## 目标与非目标

**目标:**

1. 定义级 `mcpServers` 生效：引用型共享父连接（borrowed）、内联型 per-task 作用域动态建连（owned）、作用域随子代理结束关闭；借用连接取消只取消请求不销毁物理连接。
2. 专属 MCP 工具经作用域完成枚举/descriptor/执行，不进入全局路由（父会话不受污染）；fresh 默认可见父 MCP 的 2a 契约保持。
3. `myagent --agent <type>`：argv 解析 + 主线程装配（system prompt 组合注入、model 覆盖、tools 名单、initialPrompt 首轮合并），官方同语义的不生效字段清单。

**非目标:**

- 命令型 hooks（独立立项）、子代理记忆（留待评估）、`--agents <json>` 内联定义通道、内联连接与全局同名服务器的连接级合并（官方也是独立连接）。
- 主线程消费定义级 permissionMode/hooks/mcpServers/maxTurns/background（与官方一致不消费）。
- system prompt 的"替换"语义（有意差异：保留基础人设组合，规范明示）。

## 架构决策

### D1: CLI argv 解析（`src/index.ts`）

`main()` 开头新增最小 argv 解析（手动扫描 `--agent <type>`，无第三方依赖；未知 flag 忽略保持向后兼容）。解析结果传入注册表解析与 SessionManager 装配。未知类型提示并回退默认（官方 warn 语义）。

### D2: MCP 作用域句柄 `AgentMcpScope`（`McpManagerPort.ts` + `mcp-client.ts`）

**核心决策：放弃"共享 manager + 按名动态表"，改为每个子代理任务独立的 MCP 作用域句柄**（对齐官方 per-call 保存连接句柄语义）。理由：按名索引的动态表在两个并发子代理声明同名内联服务器时互相踩踏，且无法区分同名全局引用与内联连接；scope 句柄让并发隔离、清理归属、路由归属自然收敛。

- 端口新增：
  ```ts
  interface AgentMcpScope {
    getTools(): Promise<Record<string, unknown>[]>;      // 引用+内联工具合并枚举
    getToolDescriptor(name: string): McpToolDescriptor | undefined;
    callTool(name, args, authorization, signal?, options?): Promise<unknown>; // options.disconnectOnAbort 由身份决定
    close(): Promise<void>;                               // 幂等；只关内联
  }
  McpManagerPort.openAgentMcpScope(agentId, declarations): Promise<AgentMcpScope>;
  ```
- 实现（`McpToolManager` 内）：
  - scope 持有 `inlineConnections: Map<declName, {client, transport}>`（**作用域私有**，非全局 map）+ 引用声明名集合 + `closed` 标志。
  - `getTools()`：引用服务器经全局 connections 的 client 枚举（复用全局连接）；内联服务器经 scope 自己的 client 枚举；沿用既有工具名冲突保护（与已挂载工具重名抛错，fail-closed）。
  - `callTool(name, args, authorization, signal, { disconnectOnAbort })`：路由到 scope 内联连接或全局引用连接；Abort 行为按身份——owned（内联）`disconnectOnAbort: true`（复用既有强制清理语义）、borrowed（引用）`disconnectOnAbort: false`（只中止在途请求，绝不销毁物理连接）。为此 `McpToolManager.callMcpTool` 的 abort 处理需支持 `disconnectOnAbort` 选项（默认 true 保持现状）。
  - `close()`：关闭全部内联连接（复用优雅关闭 + taskkill 进程树清理），幂等（`closed` 标志）；引用连接不动。
  - **总清理兜底**：`McpToolManager` 维护 `agentScopes: Map<agentId, AgentMcpScope>`；`close()` 与同步 exit 清理遍历全部 scope 关闭（P2：进程退出/提前关闭不残留子进程）。
- `McpServerEntry` 类型复用（`src/config/types.ts:79`），内联配置走同一白名单 env 过滤（`buildSubprocessEnv`）。

### D3: 子代理运行时接入（`SubagentCoordinator.ts` + `SubagentRuntime.ts` + `ScopedToolRegistry.ts`）

- 协调器提交点：定义 `mcpServers` 归一化为 `{ references: string[], inline: Array<{name, config}> }` 透传 `runTask`（新 `agentMcpDeclarations` 字段；exact-fork 不适用）。
- 运行器 `runTask`：任务启动时 `mcpManager.openAgentMcpScope(agentId, declarations)`（引用不存在/内联建连失败 → warning 不阻断，对应工具不可用）；`finally` 清理阶段 `scope.close()`（正常/失败/取消统一收敛）。
- `ScopedToolRegistry`：新增可选 `agentMcpScope` 注入。
  - `getTools()`：父工具面（含父 MCP 工具，freshForeground 既有契约）过滤后，**附加** scope 声明工具。
  - `getTool(name)`/可见性：scope 工具独立于 `definitionToolVisibility`（它们是定义声明的专属工具）。
  - `callTool(name, ...)`：name 命中 scope descriptor 时**旁路**到 scope.callTool——先经统一权限网关（复用 `parent.evaluateToolPermissionCandidate` 候选分析与父审批端口，ask→父审批、allow→执行），再按身份（内联 owned / 引用 borrowed）路由；不命中则走既有 parent 委托路径。审计由作用域记录。
- 父会话隔离：scope 连接不进全局 `connections`/`toolRouter`，父 `getMcpTools`/`ToolCatalog` 天然不可见（已验证 `getMcpTools` 只遍历全局 connections）。

### D4: 定义解析（`AgentDefinitionLoader.ts` + `SubagentDefinitionRegistry.ts`）

- loader：`mcpServers` 与 `initialPrompt` 从"未启用/未解析"转为解析——`mcpServers` 数组元素为字符串（引用）或对象（内联 `{ name: McpServerEntry }` 限一项），非法元素拒绝该项并记录日志；`initialPrompt` 为非空字符串。两者不使定义整体失效。
- `SubagentDefinition` 增加 `mcpServers?: ReadonlyArray<string | { readonly name: string; readonly config: McpServerEntry }>` 与 `initialPrompt?: string`。

### D5: --agent 主线程装配（`session.ts` + `context.ts` + `assembler`）

- **system prompt（组合语义，有意差异）**：`SessionContext` 新增持久附加位 `setAgentSystemPrompt(text)`；`updateSystemPrompt` 组装时（`buildSystemPrompt` 加 `agentSystemPrompt` 参数，stable 层之后附加）恒带上该文本——**RuleManager 构造与技能变更重载都不会覆盖定义正文**（`context.ts` 内部合并，非调用方注入）。语义：基础人设 + 定义正文，规范明示与官方"替换"不等价。
- **model**：定义 `model` 非 `inherit` 时构造后 `switchModel(getModelConfig(profileId, { allowEnvModelOverride: false }))`（复用 2a 冻结语义）。
- **tools**：定义 `tools/disallowedTools` 注入 assembler 主线程名单配置（D6）；省略或 `['*']` 不裁剪（含 `Agent`）；显式名单只含名单工具（`Agent` 写入才保留）。
- **initialPrompt**：保存为"待消费首轮前缀"；首条真实用户输入提交时与该输入合并为同一条 user 消息（对齐官方 `main.tsx:2091` 拼接语义），不提前插入独立消息。
- **不生效字段**：permissionMode/hooks/mcpServers/maxTurns/background 不消费。

### D6: 主线程工具名单过滤（`model-request-assembler.ts`）

复用 `finalRequestTools` 过滤机制：assembler 新增可选"主线程定义工具名单"（`tools` 允许集 + `disallowedTools` 剔除集），在 plan 剥离之后应用；允许集为空（省略/`['*']`）时按剔除集过滤，否则只保留允许集成员再剔除。SessionManager 在 `--agent` 模式注入，默认不生效（现有行为零变化）。

## 风险与权衡

- [scope 内联子进程残留] -> `close()` 复用既有优雅关闭 + taskkill 进程树清理；幂等（closed 标志）；manager `close()`/exit 同步清理兜底遍历全部 scope；测试覆盖正常/失败/取消路径。
- [动态工具旁路执行绕过网关] -> 旁路前必过 `evaluateToolPermissionCandidate` + 父审批端口（ask→审批、无端口→拒绝），与既有 MCP 权限链语义一致；契约测试覆盖授权与拒绝。
- [借用连接取消语义变更影响既有调用] -> `callMcpTool` 的 `disconnectOnAbort` 默认保持 true（现状），仅 scope 借用路径传 false；补"取消引用型后父会话仍可调用"测试。
- [主线程工具名单与 plan 剥离交互] -> 顺序固定：先 plan 剥离、后定义名单；契约测试覆盖叠加。
- [组合 system prompt 与官方不等价] -> 有意差异，proposal/spec 明示；基础人设安全红线不丢失为收益。
- [initialPrompt 合并时机] -> 前缀存储于会话，首条输入提交时拼接；无首条输入（如仅 `-p` 批处理）时行为以既有路径为准。

## 迁移计划

无数据迁移。`--agent` 为新增可选 CLI 参数；`mcpServers`/`initialPrompt` 为新增生效字段。回滚：不使用 `--agent` 参数 + 删除定义中相关声明即可恢复旧行为。

## 开放问题

- 无（关键事实均已核实：ToolCatalog MCP 策略、callMcpTool abort 语义、全局路由结构、buildSystemPrompt 组合、官方 agentToolUtils 名单语义）。
