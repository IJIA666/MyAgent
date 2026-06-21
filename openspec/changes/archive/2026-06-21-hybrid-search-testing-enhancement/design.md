# Design - Hybrid Search Testing Enhancement

本变更专注于测试补强。设计方案将通过模拟底层数据库组件异常与输入边界数据来检验 `LongTermMemoryPlugin` 在异常与防御水位下的运转稳健性。

## 1. 详细测试方案设计

### A. 向量检索单路异常容错单元测试
- **测试目的**：验证当向量检索依赖（例如嵌入计算或向量存储库）发生故障抛出异常时，插件能静默捕获并确保物理关键字检索路能够独立完成召回注入，主流程管道不发生崩溃。
- **Mock 设计**：
  - `mockEmbedding.generateEmbedding` 在执行时抛出特定的 `Error('Vector service timeout')`。
  - 物理 `MEMORY.md`（tempMemoryPath）包含目标事实（例如 `SessionManager` 事实）。
  - 用户 Query 包含能够提取的标识符以唤起物理检索。
- **执行与断言**：
  - 调用 `BeforeModel` 拦截。
  - 断言 `next()` 中间件函数正常被调用。
  - 断言 `llmRequest.messages` 头部或首个 System 消息尾部成功注入了物理关键字路召回的记忆内容（`- **SessionManager**`），且没有包含任何向量结果，没有发生主流程异常中断。

### B. 用户 Query 防御性硬截断单元测试
- **测试目的**：验证当用户发送了超长（例如 2500 字符以上）的巨量文本时，插件能够在发起 embedding 计算前安全截断为前 2000 字符，防御潜在的 API 计费溢出和 Token 超限风险。
- **测试设计**：
  - 构造一个 `const longQuery = 'a'.repeat(2500)` 的用户最新消息。
  - Spy 监视 `mockEmbedding.generateEmbedding` 的调用。
- **执行与断言**：
  - 触发 `BeforeModel` 钩子。
  - 检查并断言 `mockEmbedding.generateEmbedding` 被调用时传入的参数其长度精确等于 2000（即 `longQuery.substring(0, 2000)`）。

## 2. 影响与回归分析
- 这些测试都是在 `test/brain/plugins.test.ts` 中新增独立的 `it` 用例。
- 所有的 Mock 服务都严格限定在对应测试用例块内，不污染外部公共的 `describe` 全局测试环境，保障测试套件的无状态与原子性。
