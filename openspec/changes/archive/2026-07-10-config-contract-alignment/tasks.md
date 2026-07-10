## 1. 收紧类型并完成加载器装配

- [x] 1.1 将 `RuntimeLimitsConfig.modelTimeoutMs` 与 `RuntimeLimitsConfig.subAgentTimeoutMs` 改为必填 `number` 字段，使 `AppConfig` 装配遗漏在编译期失败。
- [x] 1.2 在 `src/config/loader.ts` 中复用现有整数解析逻辑并增加 Node.js 定时器安全范围校验，解析 `AGENT_MODEL_TIMEOUT_MS` 与 `AGENT_SUB_AGENT_TIMEOUT_MS`；缺失、无法解析、非正数或超出范围时使用默认值 `60000`，并写入 `runtimeLimits`。
- [x] 1.3 在 `.env.example` 的运行限制区域补充两个环境变量的注释示例，明确它们分别控制 AgentLoop 单次模型调用超时和后台自省子智能体总超时，并与 `AGENT_LLM_TIMEOUT` 区分。
- [x] 1.4 更新所有受必填字段影响的 `AppConfig` / `RuntimeLimitsConfig` 测试夹具，避免通过类型断言绕过新契约。

<!-- checkpoint: npx tsc --noEmit -->

## 2. 消除消费方重复默认值

- [x] 2.1 在 `src/core/usecases/brain/MemoryService.ts` 中直接读取构造参数 `appConfig.runtimeLimits.subAgentTimeoutMs`，移除可选链与 `?? 60000`。
- [x] 2.2 在 `src/core/usecases/engine/agent-loop.ts` 的模型调用边界显式检查 `this.context.appConfig` 已注入；缺失时抛出可定位的初始化错误，存在时直接读取 `runtimeLimits.modelTimeoutMs`，不得使用非空断言或本地默认值。
- [x] 2.3 搜索 `modelTimeoutMs`、`subAgentTimeoutMs` 及对应的 `60000` 回落，确认这两个字段不再存在加载器之外的默认值定义；不扩展到无关 `runtimeLimits` 字段。

<!-- checkpoint: npx tsc --noEmit -->

## 3. 验证配置链路

- [x] 3.1 扩展 `test/config/loader.test.ts`：验证两个环境变量的自定义正整数值能够写入 `runtimeLimits`，并验证缺失、空白、无法解析、非正数或超出 Node.js 定时器安全范围时均回落到 `60000`。
- [x] 3.2 扩展 AgentLoop 定向测试：验证配置的 `modelTimeoutMs` 被用于创建单次请求超时，并验证执行时缺少 `appConfig` 会报告明确初始化错误。
- [x] 3.3 扩展 MemoryService 定向测试：验证配置的 `subAgentTimeoutMs` 控制后台自省总超时，且不再依赖消费方本地默认值。

<!-- checkpoint: npx vitest run test/config/loader.test.ts test/core/usecases/engine/agent-loop.test.ts test/core/usecases/brain/MemoryService.test.ts -->
