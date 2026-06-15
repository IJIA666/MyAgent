## 1. 独立执行引擎抽取 (Agent Loop Extraction)

- [x] 1.1 新建 `src/brain/agent-loop.ts`，定义 `AgentLoop` 类并将 `AgentEvent` 事件类型定义迁移至本文件中。将原本 `SessionManager` 中的 `chat` 异步生成器循环的核心推理流（包含 Token 水位预测、API 调用、事件推送、工具执行分发、日志追踪记录）以及 `checkCacheAndCalibrate` 缓存失效诊断函数移植重构成 `AgentLoop` 的核心执行方法，确保其在运行时动态接受最新的 `tracer`、`llmConfig` 等外部变化依赖。

<!-- checkpoint: npm run build -->

## 2. 会话管理纯化与门面适配 (Session Manager Purification & Facade Integration)

- [x] 2.1 修改 `src/brain/session.ts`，移除原有的 `chat` 及 `checkCacheAndCalibrate` 具体实现。
- [x] 2.2 在 `SessionManager` 内引入并实例化 `AgentLoop`，将 `chat` 接口改造成轻量门面，直接委托 `AgentLoop` 的方法执行，并在 `SessionManager` 内部保留 `getLastEstimatedUsage`、`getLastApiUsage` 与 `getSystemPromptHash` 等原有的 Getter 接口并进行内部委托，保障外部零修改兼容。

<!-- checkpoint: npm run build -->

## 3. 单元测试适配与全量质量校验 (Quality Assurance & Regression Testing)

- [x] 3.1 修改大脑层相关单元测试，适配重构后的新架构（检查依赖引入路径）。
- [x] 3.2 运行项目的静态风格检查与全量功能回归测试，保障重构后的通过率与合规性。

<!-- checkpoint: npm run test -->
