## 改造原因

现有日志系统的核心问题已经被重新收敛：不是缺少一个更大的日志框架，而是缺少可追踪的诊断日志、可读且唯一的文件命名，以及不破坏恢复语义的结构化 trace 表达。

当前仓库里已经能看到几个直接影响排障效率的问题：

1. `session.ts`、`context.ts` 里关键状态切换仍然缺少稳定日志。
2. `trace`、`audit`、`session` 文件命名仍不够可读，也缺少真正可靠的唯一性保证。
3. trace 内容有重复上下文问题，但必须保持黑匣子可回放性，不能简单把 prompt 只写一次。

这次变更的目标不是重写存储层，而是在现有语义下把可观测性做扎实。

## 变更内容

1. 补充关键状态切换日志。
   - 覆盖 `session.ts` 中的生成、收尾、自动唤醒、错误收尾等关键节点。
   - 覆盖 `context.ts` 中的工作模式切换与锁定失败路径。
   - 覆盖 `plugin-runner.ts` 中的 `isProcessing` 状态变迁。
   - 日志属性必须使用结构化字段，不再把唯一语义压在拼接字符串里。
   - 正常操作日志（`generation_*`、`snapshot_saved`）使用 `debug` 级，仅落文件不污染控制台。

2. 统一 trace / audit / session 的命名策略。
   - 采用一次生成、全链路复用的单一 `sessionId`。
   - `sessionId` 采用 UTC 毫秒时间前缀加完整 UUID 后缀，确保同会话文件可关联且全局唯一。
   - 保持新旧命名兼容，方便排查和后续迁移。

3. 优化 trace 的结构化表达。
   - 定义闭合的 JSONL 联合类型，明确 `meta`、`prompt_definition`、`iteration` 等记录。
   - 使用 `initialSystemPromptHash` 区分会话初始 prompt 与后续变化。
   - 在 prompt 发生变化时写入完整定义，并让后续 iteration 仅引用 hash。

4. 新增 trace 读取能力。
   - 明确 `TraceReader` 的公开 API、返回类型和旧格式兼容策略。
   - 支持损坏尾行忽略、旧 trace 兼容、prompt definition 回放。
   - 调用方限定为诊断回放工具与测试，不进入在线生成主链路。

5. 明确不做的事。
   - 不把 `ContextRepository` 改成 JSONL 追加。
   - 不为 `run.log` 再增加第二套清理逻辑。
   - 不扩展 `LifecycleManager` 的 startup 框架。

## 业务能力

### 修改业务能力

- `logging-observability-and-naming`: 提升关键状态诊断能力、会话文件可检索性和 trace 黑匣子表达能力，同时保持 session 快照恢复语义不变。

## 影响范围

1. `src/core/usecases/engine/session.ts`
2. `src/core/domain/context.ts`
3. `src/core/domain/tracer.ts`
4. `src/core/domain/trace-reader.ts`
5. `src/core/usecases/brain/ContextRepository.ts`

## 风险控制

1. 不改 session 快照语义，避免恢复逻辑失效。
2. 不引入新的生命周期框架，避免把日志整改变成架构改造。
3. 所有命名变更都要共享同一个 session 身份，避免同会话文件失联。
4. trace 结构必须闭合，避免只给出示例而不给出可解析 schema。
5. trace 回放必须由明确的读取器 API 支撑，避免“格式可回放但实现不可验证”。
