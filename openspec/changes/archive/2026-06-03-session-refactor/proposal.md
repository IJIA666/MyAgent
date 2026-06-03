## 改造原因

`SessionManager` 随着功能迭代已膨胀至 400+ 行，承担了状态管理、网络请求、流式解析以及智能体 ReAct 引擎的多重职责，严重违反单一职责原则 (SRP)。为了支持未来接入非 OpenAI 协议的模型以及更复杂的状态持久化存储，必须将其按领域拆解。

## 变更内容

- 将文件读写与历史消息维护逻辑剥离至独立的 `SessionContext` 中。
- 将 OpenAI 客户端初始化与 DeepSeek 特定的大模型流式解析逻辑剥离至 `LlmDriver` 中。
- `SessionManager` 降级为外观 (Facade) 控制层，专门协调 `SessionContext`、`LlmDriver` 与 `ToolRegistry` 之间的交互循环。
- **不改变外层接口**：`cli.ts` 和 `command.ts` 等调用方对本次重构尽量保持无感。

## 业务能力

### 新增业务能力
无（纯技术架构重构，不涉及外部业务能力新增）。

### 修改业务能力
无（现有行为如自动补全、会话持久化等能力规格不变）。

## 影响范围

- 核心影响文件：`src/brain/session.ts`（拆分为多个更小职责的文件）
- 新增关联模块：负责持久化的状态类，负责大模型的驱动类。
- 受影响调用方：`src/interface/cli.ts`、`src/interface/command.ts`、`src/index.ts`（可能会涉及引入模块或参数的轻微调整）。
