## 1. 基础模块提取：SessionContext

- [x] 1.1 创建 `src/brain/context.ts`，实现 `SessionContext` 类
- [x] 1.2 将 `session.ts` 中的 `messageHistory`、`sessionId`、`saveState`、`loadState` 迁移至此类
- [x] 1.3 为 `SessionContext` 增加用于上下文状态同步和异常安全处理的辅助方法（如 `addMessage`, `popMessage`）

<!-- checkpoint: npx tsc --noEmit -->

## 2. 核心模块提取：LlmDriver

- [x] 2.1 创建 `src/brain/driver.ts`，实现 `LlmDriver` 类
- [x] 2.2 迁移 `OpenAI` client 的初始化与配置管理，实现对 `LlmConfig` 的管控
- [x] 2.3 迁移大模型调用逻辑，解析数据流并拼装 `tool_calls`，将原有的 DeepSeek 特有逻辑封装在内
- [x] 2.4 将 `abortController` 相关逻辑及网络中止能力绑定在该类中

<!-- checkpoint: npx tsc --noEmit -->

## 3. SessionManager 降级重构与连线

- [x] 3.1 修改 `src/brain/session.ts`，在 `SessionManager` 中组合调用 `SessionContext` 与 `LlmDriver`
- [x] 3.2 重构 `SessionManager.chat()`，它只负责调用 `LlmDriver`，并在遇到 `tool_calls` 时流转调度 `ToolRegistry`
- [x] 3.3 在 `chat()` 异常 `catch` 及正常退出的 `finally` 区块内，联动 `SessionContext` 的静默落盘
- [x] 3.4 保持原本暴露的代理方法签名（`getHistory`, `rollback`, `getModelName` 等）完全不变，确保 `cli.ts` 与 `command.ts` 等调用方无须更改

<!-- checkpoint: npx tsc --noEmit -->
