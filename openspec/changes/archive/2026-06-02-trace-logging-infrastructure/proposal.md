## 改造原因

随着 Agent 功能和场景的扩大，我们需要明确区分“大模型能力不足”和“框架 Harness 缺陷”。当前，模型交互的完整快照仅输出于终端，无法留档进行 Post-mortem（事后复盘）和 Benchmark 分析。因此，急需建立可观测性基建（Observability），即 Trace 记录仪。

## 变更内容

- 新增 `src/brain/tracer.ts` 提供结构化日志落盘能力。
- 拦截 `SessionManager` 中的流式响应闭环，将完整的上下文和思考过程写入本地 `.myagent/traces/`。

## 业务能力

### 新增业务能力
- `trace-logging`: 提供大模型交互历史的全量结构化（JSONL）落盘和可观测性追踪。

### 修改业务能力
无

## 影响范围
- **受影响模块**：`src/brain/session.ts`, `src/index.ts`
- **外部影响**：将在授权的工作区内隐式生成 `.myagent/traces` 文件夹。
