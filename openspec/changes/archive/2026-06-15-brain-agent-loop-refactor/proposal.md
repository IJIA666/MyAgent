## 改造原因

在大模型智能体大脑层中，`SessionManager` 兼任了对话历史存储、会话状态持久化管理、以及多轮 ReAct 推理状态机与工具分发的双重职责。由于状态控制逻辑与底层推理执行流深度耦合，导致 `session.ts` 的代码体量急剧膨胀，这极大地降低了核心决策引擎的独立可测试性。为了提高大脑层的正交性与扩展弹性，我们需要对大脑层进行一次纵向解耦，将推理流大环路的状态机抽离，使得 `SessionManager` 成为轻量级的数据模型与会话状态门面。

## 变更内容

1. **核心逻辑解耦**：从 `SessionManager` 中剥离 `chat` 异步生成器循环和缓存击穿检测 `checkCacheAndCalibrate` 逻辑，将其移至新建的 `AgentLoop` 类（`agent-loop.ts`）中。
2. **纯化会话管理**：`SessionManager` 退化为纯正的会话与状态存储中心，仅对外作为大脑层门面提供极简的交互接口 `talk`，其内部逻辑将直接委托给 `AgentLoop` 执行。
3. **保持 API 向后兼容**：大脑层对外的调用接口（例如 `cli.ts` 引用的 `SessionManager`）及相关事件格式完全保持向前兼容。
4. **适配测试代码**：重整大脑层的相关单元测试，确保其与解耦后的架构适配并能全量通过。

## 业务能力

### 新增业务能力
- 无

### 修改业务能力
- 无

## 影响范围

- 新增 `src/brain/agent-loop.ts` 文件。
- 修改 `src/brain/session.ts` 中的 `SessionManager` 实现。
- 外层调用端如 `src/interface/cli.ts` 依然保持调用 `SessionManager`，调用路径与契约完全兼容。
- `test/brain/` 下的单元测试适配回归。
