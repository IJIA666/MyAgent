## 改造原因

用户输入中显式提及子代理类型（`@agent-<type>`）时，当前没有引导机制——用户意图依赖模型自行从自由文本推断。官方把提及转成高优先级提醒（agent_mention attachment → system-reminder 包裹的 meta 消息，messages.ts:3946-3953），明确引导模型"用户希望调用该 agent，请适当调用"；**不绕过 Agent 工具**（启动仍走模型经 Agent 工具的既有全链）。MyAgent 按形态适配：输入预处理 + 提醒 user 消息注入。

## 变更内容

1. `handleUserInput`（session.ts:1337 addUserMessage 前）检测 `@agent-<type>` 提及（正则 `(^|\s)@agent-([\w.:@-]+)\b`，对齐官方 extractAgentMentions）。
2. 匹配 `subagentDefinitionRegistry.resolve(type)`：已注册 → 注入**单条聚合提醒 user 消息**（多条提及合并，避免连续 user 消息），置于用户消息之前，措辞对齐官方（"用户表达了调用子代理 X 的意图，请适当调用该子代理并传递所需上下文"）；未注册 → 不注入，`@agent-<type>` 文本原样保留。
3. 提醒为独立 user 消息，不参与 `--agent` initialPrompt 合并（合并仅作用于首条真实用户输入本身）。

无 BREAKING：纯增量引导，Agent 工具与子代理执行链零改动；未提及时不产生任何变化。

## 业务能力

### 新增业务能力
- `subagent-at-mention`: 用户输入 `@agent-<type>` 提及已注册子代理类型时，注入高优先级提醒引导模型经 Agent 工具调用（不绕过工具；未注册类型不注入）

### 修改业务能力
（无修改）

## 影响范围

- `src/core/usecases/engine/session.ts`：handleUserInput 预处理 + 提醒注入
- 新增提醒构造工具函数（提取检测/聚合逻辑，便于单测）
- 测试：已注册/未注册/多条提及/initialPrompt 共存/无提及零变化
