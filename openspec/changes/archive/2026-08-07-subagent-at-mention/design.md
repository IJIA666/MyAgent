## 背景

官方 `@agent-<type>` 提及 → `agent_mention` attachment → `<system-reminder>` meta 消息（messages.ts:3946-3953）引导模型调用。MyAgent 无 attachment 管道，用户输入入口为 `handleUserInput` → `addUserMessage`（session.ts:1337/490），SessionManager 已持有 `subagentDefinitionRegistry`。适配形态：输入预处理 + 独立提醒 user 消息。

## 目标与非目标

**目标:**
- `@agent-<type>`（已注册类型）→ 注入单条聚合提醒 user 消息（置于用户消息前），引导模型经 Agent 工具调用。
- 未注册类型不注入，原始文本保留。
- 提醒不参与 `--agent` initialPrompt 合并。

**非目标:**
- `@"<type> (agent)"` autocomplete 格式（MyAgent 无 autocomplete 输入源）。
- @文件 / @MCP 资源提及（官方 attachments 的另外两类，与本能力无关）。
- 遥测日志（官方 tengu_at_mention_* logEvent；MyAgent 无对应平台）。
- 任何绕过 Agent 工具的旁路（提醒仅是引导，启动仍走既有全链）。

## 架构决策

### D1: 输入预处理点 = handleUserInput（addUserMessage 前）

- 在 `this.addUserMessage(input)` 之前执行检测与注入：先注入提醒（独立 user 消息），再写用户消息——模型首见提醒，其次见原始输入。
- 为什么在此而非 addUserMessage 内部：addUserMessage 还承担 initialPrompt 合并，职责单一化；检测逻辑独立成函数便于单测。
- 仅 CLI 交互路径（handleUserInput）：工具生成消息、任务通知等不经过此入口，天然不触发。

### D2: 检测与匹配（对齐官方 extractAgentMentions）

- 正则 `/(^|\s)@agent-([\w.:@-]+)\b/gu`（对齐官方 `@agent-<agent-type>` 格式；[\w.:@-] 覆盖插件作用域命名，MyAgent 无插件但保留形态）。
- 逐提及 `subagentDefinitionRegistry.resolve(type)`；已注册收集，未注册跳过（不注入、不改写原文）。
- 全部未命中 → 零注入（行为与现状完全一致）。

### D3: 单条聚合提醒注入

- 多条提及合并为一条 user 消息（对齐 3a 的合并注入经验，避免连续 user 消息）：
  > 用户表达了调用子代理 "<t1>"、"<t2>" 的意图。请适当调用对应子代理（Agent 工具，subagent_type 分别取 <t1>、<t2>），并传递所需上下文。
- 提醒在 initialPrompt 合并之外：`addUserMessage` 的合并只作用于用户输入本身，提醒消息独立 addMessage。

### D4: 提醒措辞对齐官方语义

- 官方："The user has expressed a desire to invoke the agent "X". Please invoke the agent appropriately, passing in the required context to it."
- MyAgent 中文等价 + 显式给出 subagent_type（模型无需猜测类型名，与 Agent schema enum 一致）。

## 风险与权衡

- [提醒消息增加对话体积] -> 每条输入最多一条提醒（聚合），长度固定；仅在显式提及时产生。
- [模型忽略提醒] -> 与官方一致（提醒是引导非强制）；不绕过 Agent 工具的设计决定了最终调用权在模型。
- [@agent- 出现在普通文本（如代码片段）] -> 正则要求 `(^|\s)@agent-` 边界；与官方同语义，误匹配时注入的也只是提醒（无害）。

## 迁移计划

- 无数据迁移；未提及时零行为变化；回滚 = 移除预处理调用。

## 待确认问题

- 无（探索期已核实：官方解析/渲染/遥测、MyAgent 输入入口与注册表持有、无 attachment 管道的适配形态）。
