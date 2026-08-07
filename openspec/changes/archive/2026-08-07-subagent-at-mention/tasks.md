## 1. 提醒构造与检测工具

- [x] 1.1 新增提及检测工具函数（`extractAgentMentions(input)`：正则 `(^|\s)@agent-([\w.:@-]+)\b`，返回提及类型列表）
- [x] 1.2 新增提醒构造函数（`buildAtMentionReminder(types)`：多条聚合为单条 user 消息，措辞对齐官方语义并显式给出 subagent_type）

<!-- checkpoint: npm run build -->

## 2. 输入入口接入

- [x] 2.1 `handleUserInput` 在 `addUserMessage` 前执行：检测 → 注册表 resolve 过滤 → 命中时注入提醒 user 消息（置于用户消息前）；未命中零变化
- [x] 2.2 提醒注入不参与 `--agent` initialPrompt 合并（合并仅作用于用户输入本身，提醒独立 addMessage）

<!-- checkpoint: npm run build -->

## 3. 测试与门禁

- [x] 3.1 单测：已注册提及注入（提醒内容含类型与 subagent_type）、纯提及、未注册不注入、多条合并单条、无提及零变化
- [x] 3.2 单测：提醒与 initialPrompt 合并共存（首条输入提及 + --agent 前缀均正确——提醒独立 addMessage 不参与合并）
- [x] 3.3 全量门禁：lint + build + 单测（1272）+ 契约测试（133）+ 类型检查

<!-- checkpoint: npm run lint -->

<!-- checkpoint: npm test -->

<!-- checkpoint: npm run test:contract -->
