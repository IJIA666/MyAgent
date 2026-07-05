## 1. 数据模型升级

- [x] 1.1 在 `src/ports/driven/session/InteractionPort.ts` 中定义新的结构化类型：`QuestionOption`、`QuestionMode`、`UserQuestion`、`AskUserAnswer`
- [x] 1.2 更新 `AskUserPayload` 接口：旧的单题 `title/options` 模式改为 `questions: UserQuestion[]`
- [x] 1.3 更新 `InteractionPort.askUser()` 返回签名：`Promise<string>` → `Promise<AskUserAnswer>`
- [x] 1.4 更新 `src/core/domain/context.ts` 中 `QuestionPayload` 和 `PendingInteraction` 的 `answer` 类型为 `AskUserAnswer`
- [x] 1.5 更新 `src/ports/driven/session/InteractionPort.ts` 中 `InteractionRequestError.payload` 类型对齐新 `AskUserPayload`

<!-- checkpoint: npx tsc --noEmit -->

## 2. ask 工具 Schema 与校验升级

- [x] 2.1 更新 `src/adapters/tools/impl/interaction/ask-user-question.ts` 中工具的 `definition` 参数 schema：主参数改为 `questions`
- [x] 2.2 为每个问题增加显式 `mode` 校验，并约束选择题必须提供结构化 `options`
- [x] 2.3 更新 `AskUserQuestionTool.execute()` 中的参数校验，确保抛出的 `InteractionRequestError` 携带新 `AskUserPayload`

<!-- checkpoint: npx tsc --noEmit -->

## 3. CLI 幂等恢复与交互渲染重构

- [x] 3.1 在 `src/adapters/input/interface/facade.ts` 的 `CliFacade` 类中新增 `activeInteractionIds: Set<string>` 字段
- [x] 3.2 在 `handlePendingInteraction` 入口增加 `interactionId` 去重校验，确保 `interaction_request` 与 `/resume` 不会并发拉起同一提问 UI
- [x] 3.3 重写 `src/adapters/input/interface/interaction-handler.ts` 的 ask 渲染分支
- [x] 3.4 支持 `questions.length > 1` 的顺序渲染与答案收集，返回统一的 `AskUserAnswer`

<!-- checkpoint: npx tsc --noEmit -->

## 4. Session 与持久化链路适配

- [x] 4.1 更新 `src/core/usecases/engine/session.ts` 中 `resumePendingInteraction()` 的入参类型：`answer: string` → `answer: AskUserAnswer`
- [x] 4.2 更新 `resumePendingInteraction` 中的答案写入逻辑，以结构保持的 JSON 文本回填 tool 消息
- [x] 4.3 更新 `src/core/usecases/brain/ContextRepository.ts` 中 `pendingInteraction` 的序列化与反序列化，识别新的 ask 载荷格式
- [x] 4.4 对旧版 ask 快照采用安全丢弃策略，不再为旧 `title/options` 载荷增加迁移协议

<!-- checkpoint: npx tsc --noEmit -->

## 5. OpenSpec 制品收敛

- [x] 5.1 将本次 change 的 spec 收敛为对既有 `ask-user-question` 能力的 MODIFIED requirements
- [x] 5.2 删除 `structured-ask` / `ask-lifecycle-protection` 这种平行 spec，避免同一能力分叉描述

<!-- checkpoint: npx tsc --noEmit -->

## 6. 测试覆盖

- [x] 6.1 更新 `ask-user-question` 工具测试：覆盖 `questions[]`、`mode`、结构化 `options` 校验
- [x] 6.2 新增 `InteractionHandler` 基础签名测试：验证新 payload 格式兼容
- [x] 6.3 新增 `CliFacade` 防重保护测试：验证 `interaction_request` 对同一 `interactionId` 的幂等性
- [x] 6.4 更新 `CliFacade` 请求处理测试：验证结构化答案回填

<!-- checkpoint: npx vitest run src/adapters/tools/impl/interaction/ -->
