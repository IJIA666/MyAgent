## 改造原因

当前 `ask_user_question` 交互契约存在三个层次的断裂：

1. **生命周期层**：`CliFacade.handlePendingInteraction()` 缺少针对同一 `interactionId` 的幂等保护，`interaction_request` 事件与 `/resume` 命令可能重复拉起同一提问 UI。
2. **数据模型层**：提问仍是单题 + 平铺 `string[]` 选项，缺少结构化 `label`/`description`，也无法把不同语义维度拆成多个独立问题。`multiSelect` 虽已暴露到工具参数，但整条链路仍是单值答案模型。
3. **渲染层**：ask 交互仍维护手写 `readline` 分支，而仓库主路径已经在使用 `@clack/prompts`；两套交互栈并行演化会继续放大取消语义、stdin 独占和显示样式的漂移风险。

竞品调研（OpenCode、Codex、Claude Code）已验证结构化选项 + 批量问题 + 多选是成熟路径，当前差距可以收敛。

## 变更内容

### 修改行为

- **CLI 幂等恢复**：同一挂起提问在任一时刻只允许存在一个活动 UI；重复的 `interaction_request` 与 `/resume` 必须被忽略。
- **提问契约升级**：单题 `title/options` 模式升级为 `questions[]` 批量问题模型，每个问题显式携带 `id`、`header`、`question`、`mode` 与结构化选项。
- **多选全链路落地**：多选不再停留在工具参数布尔标记，而是贯通工具 Schema、`InteractionPort`、领域挂起态、CLI 渲染和恢复链路。
- **答案模型升级**：用户回答从单个 `string` 升级为按问题 `id` 索引的结构化答案映射，禁止再用分隔符把多选折叠回单字符串。
- **CLI 交互统一**：ask 的单选、多选、文本输入与“Other”分支统一收敛到 `@clack/prompts` 栈，不再继续扩展手写 `readline` 交互。
- **快照载荷升级**：`pendingInteraction.payload` 与 `answer` 随新契约一并升级；本次 change 不再把“兼容旧 ask 载荷格式”作为目标。

## 业务能力

### 修改业务能力

- `ask-user-question`

## 影响范围

- `src/ports/driven/session/InteractionPort.ts` — 接口签名变更（BREAKING）
- `src/core/domain/context.ts` — PendingInteraction / QuestionPayload 类型变更
- `src/core/usecases/engine/session.ts` — resumePendingInteraction 升级
- `src/core/usecases/brain/ContextRepository.ts` — 快照序列化格式升级
- `src/adapters/tools/impl/interaction/ask-user-question.ts` — 工具参数 schema 升级
- `src/adapters/input/interface/facade.ts` — CLI 防重保护
- `src/adapters/input/interface/interaction-handler.ts` — 多选渲染 + @clack/prompts 收敛
- `src/adapters/input/interface/select.ts` — 若复用现有 Clack 适配层，需要补充多选/文本场景
- 对应测试文件
