# 探索：@-mention 用户引导

> 状态: active
> 创建: 2026-08-07
> 依据: 官方源码核实（attachments.ts:1966-1993 extractAgentMentions、messages.ts:3946-3953 agent_mention 渲染、processUserInput.ts:554-572）+ MyAgent 现状核实（session.ts handleUserInput/addUserMessage、SubagentDefinitionRegistry）
> 上游: openspec/explorations/subagent-evolution-roadmap.md（@-mention 用户引导，激活为进行中）

---

## 1. 目标

用户输入中以 `@agent-<type>` 提及已注册子代理类型时，把该意图转成高优先级提醒注入会话（引导模型调用 Agent 工具），**不绕过 Agent 工具**（最终仍由模型经 Agent 工具启动子代理，走既有权限/扫描/通知链路）。

## 2. 官方机制核实

- **解析**（attachments.ts:1966-1993 + 2802）：两种格式——`@agent-<type>`（手动输入，正则 `(^|\s)@agent-...`）与 `@"<type> (agent)"`（autocomplete 选择）；`processAgentMentions` 用 `agents.find(def => def.agentType === type)` 匹配已注册定义，未命中仅 logEvent（不生成 attachment）。
- **渲染**（messages.ts:3946-3953）：`agent_mention` attachment 转成 `<system-reminder>` 包裹的 meta 用户消息：
  > "The user has expressed a desire to invoke the agent "X". Please invoke the agent appropriately, passing in the required context to it."
- **遥测**（processUserInput.ts:554-572）：区分"纯提及"（输入只有 @agent-x）与"前缀提及"（@agent-x 后还有内容）。
- **不绕过 Agent 工具**：提醒只是引导模型调用，子代理启动仍经 Agent 工具（权限、作用域、输出扫描全链不变）。

## 3. MyAgent 现状核实

| 事实 | 证据 | 结论 |
|---|---|---|
| 用户输入入口 | `handleUserInput` → `addUserMessage(input)`（session.ts:1337/490） | 预处理点在此（addUserMessage 前） |
| 已注册类型访问 | SessionManager 持有 `subagentDefinitionRegistry`（session.ts:264） | 匹配无需新依赖 |
| 无 attachment 机制 | MyAgent 无官方 attachment 管道（3a 已确认） | 提醒以独立 user 消息注入（MyAgent 形态） |
| 无 meta 消息概念 | ChatMessage 无 isMeta 字段 | 提醒作为普通 user 消息（置于用户消息前） |
| `--agent` initialPrompt 合并 | addUserMessage 内 mergeInitialPrompt | 提醒注入须与合并共存（提醒独立消息，不参与合并） |

## 4. 设计要点

1. **检测**：`handleUserInput` 的 addUserMessage 前，用 `(^|\s)@agent-([\w.:@-]+)\b`（对齐官方）提取全部提及。
2. **匹配**：`subagentDefinitionRegistry.resolve(type)`——已注册 → 注入提醒；未注册 → 不注入（@agent-x 文本原样保留在用户消息中，模型自行理解或忽略）。
3. **注入**：提醒为独立 user 消息，插在用户消息之前（模型先读提醒）：
   > 用户表达了调用子代理 "<type>" 的意图。请适当调用该子代理（Agent 工具，subagent_type: <type>），并传递所需上下文。
4. **注入次数**：一条输入多个提及 → 一条提醒聚合列出全部类型（避免多条连续 user 消息，对齐 3a 的合并注入经验）。
5. **边界**：仅 CLI 交互输入路径（handleUserInput）；工具生成消息、恢复路径不触发。

## 5. 验收

- 输入 `@agent-<type>`（已注册）→ 会话出现提醒 user 消息（列出类型）且用户原始消息保留。
- 未注册类型 → 无提醒注入，原始文本不变。
- 多条提及 → 单条聚合提醒。
- 模型仍经 Agent 工具启动子代理（提醒不提供任何旁路）。
