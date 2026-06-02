## 改造原因

在 Agent 交互过程中，模型可能会因为推理偏离、工具死循环或被用户主动叫停而中断执行。当前系统缺乏截断问题状态的机制。基于前置的架构探索论证（见 `exploration.md`），我们明确排除了高危且性能低下的“底层物理回滚（B）”路线，确立了以“上下文记忆截断（Context Rollback A）”为核心防线的方案，这是打造工业级防爆破 AI 助手的必需组件。

## 变更内容

- 引入强制打断机制，通过 `AbortController` 等方案随时阻断大模型的流式推理与工具调用过程。
- 在 `SessionManager` 中引入记忆截断能力，支持截除最近发散失败的历史轮次对话（`messageHistory` 弹栈）。
- **[Amend 修正]** 提供完善的用户级交互体验：支持双击 ESC 快捷键（防发散打断与单步回滚）以及 `/rollback N` 斜杠命令（大跨度回滚）。
- 明确边界：绝对不侵入 MCP 工具内部或物理文件层，所有物理兜底交由外层 Git 掌控。

## 业务能力

### 新增业务能力
- `context-rollback`: Agent 会话流转中的大模型打断与记忆上下文截断能力。

### 修改业务能力
（无）

## 影响范围

- `src/brain/session.ts`：负责流式响应的核心生成器需要接入打断监听；记忆数组需要提供 pop 接口。
- **[Amend 修正]** `src/interface/cli.ts`：监听按键事件 `keypress` 以实现双击 ESC。
- **[Amend 修正]** `src/interface/command.ts`：新增 `/rollback` 指令注册及 `/help` 说明。
