## 1. MCP 作用域句柄与连接管理

- [x] 1.1 `src/ports/driven/tools/McpManagerPort.ts`：新增 `AgentMcpScope` 接口（`getTools`/`getToolDescriptor`/`callTool(name, args, authorization, signal, options?)`/`close`）与 `McpManagerPort.openAgentMcpScope(agentId, declarations)`，附注释
- [x] 1.2 `src/adapters/tools/mcp-client.ts`：`McpToolManager` 实现 `AgentMcpScope`（per-task `inlineConnections` 私有 map + 引用名集合 + `closed` 幂等标志）；`openAgentMcpScope` 登记到 `agentScopes` map
- [x] 1.3 `AgentMcpScope.getTools()`：引用服务器经全局连接枚举、内联服务器经作用域连接枚举，沿用既有同名工具冲突保护（fail-closed）
- [x] 1.4 `AgentMcpScope.callTool`：按 owned（内联，abort 强制断开）/ borrowed（引用，abort 只取消请求不销毁连接）路由；`McpToolManager.callMcpTool` 增加 `disconnectOnAbort` 选项（默认 true 保持现状），借用路径传 false
- [x] 1.5 总清理兜底：`McpToolManager.close()` 与同步 exit 清理遍历 `agentScopes` 全部关闭；scope `close()` 幂等
- [x] 1.6 单测：scope 枚举/descriptor/callTool、并发同名内联互不干扰、close 幂等、manager 总关闭/exit 清理、`disconnectOnAbort: false` 取消后父连接仍可用

<!-- checkpoint: npm run build && npm run test -->

## 2. 定义解析与字段扩展

- [x] 2.1 `AgentDefinitionLoader.ts`：`mcpServers` 与 `initialPrompt` 启用解析——`mcpServers` 数组元素为字符串（引用）或对象（内联 `{ name: McpServerEntry }` 限一项），非法元素拒绝该项并记录日志；`initialPrompt` 非空字符串校验
- [x] 2.2 `SubagentDefinitionRegistry.ts`：`SubagentDefinition` 增加 `mcpServers?` 与 `initialPrompt?` 字段，自定义定义注册映射
- [x] 2.3 加载器单测：引用/内联/混合解析、非法元素拒绝、`initialPrompt` 解析、定义其余字段不受影响

<!-- checkpoint: npm run test -->

## 3. 提交点、运行器与作用域接入

- [x] 3.1 `SubagentCoordinator.submitRequest`：定义 `mcpServers` 归一化为 `{ references, inline }` 透传 `runTask`（新增 `agentMcpDeclarations` 字段，仅 fresh 子代理消费；exact-fork 不适用）
- [x] 3.2 `SubagentRuntime.runTask`：任务启动 `mcpManager.openAgentMcpScope(agentId, declarations)`（引用不存在/内联建连失败 warning 不阻断）；`finally` 清理阶段 `scope.close()`（正常/失败/取消统一收敛）
- [x] 3.3 `ScopedToolRegistry`：新增可选 `agentMcpScope` 注入——`getTools` 附加 scope 声明工具；`getTool` 支持 scope descriptor；`callTool` 对 scope 工具旁路执行（先经 `evaluateToolPermissionCandidate` + 父审批端口，再按身份路由），不命中走既有委托路径
- [x] 3.4 单测：专属工具进入子代理工具面、父会话不污染、旁路执行经权限网关（ask→审批/拒绝）、引用共享不关闭、内联随正常/失败/取消关闭、建连失败不阻断

<!-- checkpoint: npm run test:contract -->

## 4. --agent 会话模式

- [x] 4.1 `src/index.ts`：main 开头最小 argv 解析（`--agent <type>`，未知 flag 忽略）；未知类型提示并回退默认
- [x] 4.2 `src/core/domain/context.ts`：`SessionContext` 新增 `setAgentSystemPrompt(text)` 持久附加位；`buildSystemPrompt`（`prompts.ts`）增加 `agentSystemPrompt` 参数（stable 层后附加）；`updateSystemPrompt` 组装恒带附加位（RuleManager 构造与技能重载不覆盖）
- [x] 4.3 `session.ts` 主线程装配：`--agent` 时 `setAgentSystemPrompt(定义正文)`（omitClaudeMd: true 时复用 skipRules 跳过规则加载）、model 非 inherit 时 `switchModel(getModelConfig(profileId, { allowEnvModelOverride: false }))`
- [x] 4.4 `model-request-assembler.ts`：新增主线程定义工具名单配置（`tools` 允许集 + `disallowedTools` 剔除集，plan 剥离后应用；省略/`['*']` 不裁剪含 `Agent`，显式名单只含名单工具）；SessionManager 在 `--agent` 模式注入，默认不生效
- [x] 4.5 initialPrompt：保存为待消费首轮前缀；首条真实用户输入提交时与该输入合并为同一条 user 消息（不提前插入独立消息）
- [x] 4.6 不消费字段确认：permissionMode/hooks/mcpServers/maxTurns/background 主线程不消费（无装配代码）
- [x] 4.7 单测：argv 解析、未知类型回退、system prompt 组合且重载不覆盖、model 覆盖、工具名单（省略/通配含 Agent、显式名单不含、写入 Agent 才保留）、initialPrompt 合并、缺省行为零变化

<!-- checkpoint: npm run build && npm run test -->

## 5. 收尾验证

- [x] 5.1 全量 lint 与类型检查通过
- [x] 5.2 既有 subagent 契约测试无回归；装配链测试：定义声明引用+内联 MCP → 子代理可用专属工具、取消引用型调用后父会话仍可调用、子代理结束后父会话无残留；`--agent` 启动主会话全字段生效

<!-- checkpoint: npm run lint && npm run test:contract -->
