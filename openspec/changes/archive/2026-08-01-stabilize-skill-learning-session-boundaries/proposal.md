## 改造原因

当前 Skill 学习闭环已经能够在成功任务后异步复盘，也能够跨越等待用户交互的物理运行边界保存证据，但主会话与后台学习之间仍有三处边界错误：正常入口生成的复盘轨迹遗漏触发任务的用户消息；后台 Skill 变更结果会作为新的用户消息写入会话并自动唤醒主模型；Skill 文件变化会改写当前会话已经发送过的系统提示词。这三项行为分别损害学习判断、产生额外模型调用，并破坏长会话的历史语义与提示词缓存稳定性，因此必须先于后续学习能力扩展完成修正。

## 变更内容

- 为每个逻辑学习单元建立无歧义的输入起点，保证正常完成、等待用户后恢复以及多段恢复的复盘轨迹都包含最初的用户任务，同时排除更早历史和无关后台事件。
- 将 Skill 复盘结果改为仅面向宿主展示的异步事件，不作为 `user` 消息写入模型历史，不触发主 Agent 自动推理，也不延迟当前前台回合的 `complete` 生命周期。
- **BREAKING**：取消活跃会话中的 Skill 索引热改写。Skill 文件变更仍立即提交到 SkillLibrary，但当前会话的系统提示词和 Skill 元数据快照保持冻结，新内容从新会话开始生效。
- 增加覆盖真实 `SessionManager -> AgentLoop -> SkillLearningPlugin` 入口、等待恢复、后台通知和会话内提示词稳定性的契约与集成测试。

## 业务能力

### 新增业务能力

- `skill-learning-session-boundaries`: 约束逻辑学习轨迹、后台复盘结果和主会话上下文之间的隔离边界。

### 修改业务能力

- `rules-injection-caching`: 将 Skill 自动重载从“改写活跃会话系统提示词”调整为“只影响后续新会话”，保证单个会话的提示词前缀稳定。

## 影响范围

- 主运行摘要及 Hook 契约：`src/ports/shared/plugin-types.ts`、`src/core/usecases/engine/agent-loop.ts`。
- 用户输入、恢复交互和异步事件分发：`src/core/usecases/engine/session.ts`。
- 学习轨迹截取与延续状态：`src/core/usecases/plugins/SkillLearningPlugin.ts`、`src/core/domain/skill-learning-continuation.ts`、`src/core/usecases/brain/ContextRepository.ts`。
- Skill 变更订阅与提示词快照：`src/core/usecases/brain/RuleManager.ts`、`src/core/domain/context.ts`、`src/core/domain/conversation-state.ts`。
- CLI 或其他宿主的展示事件适配，以及对应的单元、契约和集成测试。
