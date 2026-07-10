## 改造原因

`RuntimeLimitsConfig` 已声明 `modelTimeoutMs` 与 `subAgentTimeoutMs`，但两个字段被定义为可选，`loadConfig()` 也没有装配它们。运行时只能分别在 `agent-loop.ts` 与 `MemoryService.ts` 中使用 `?? 60000` 兜底，导致超时值无法通过统一配置入口控制，也无法由 TypeScript 在加载器漏装配时给出错误。

当前问题的真实边界是两个超时字段的 `types.ts → loader.ts → runtime consumer` 链路。本 change 只修复该边界，不混入输出目录、日期格式、提示模板或 provider 策略等彼此独立的硬编码议题。

## 变更内容

- 将 `RuntimeLimitsConfig.modelTimeoutMs` 与 `RuntimeLimitsConfig.subAgentTimeoutMs` 改为必填字段，使 `AppConfig` 的现有类型检查能够在编译期发现加载器漏装配。
- 在 `loadConfig()` 中分别从 `AGENT_MODEL_TIMEOUT_MS`、`AGENT_SUB_AGENT_TIMEOUT_MS` 读取两个字段，缺失、无法解析、非正数或超出 Node.js 定时器安全范围时保持现有默认行为 `60000` 毫秒。
- 在 `.env.example` 中说明两个可选配置项及默认值。
- 运行时消费方只使用已装配的配置值；`AgentLoop` 在配置对象缺失时显式报告初始化错误，不再把“配置未注入”伪装成默认值回落。
- 更新受必填类型影响的测试夹具，并覆盖自定义值、默认值与消费链路。

## 业务能力

### 修改业务能力

- `config-management`：统一装配大模型单次请求超时与后台自省子智能体总超时，并将装配结果传递给运行时消费方。

## 影响范围

- `src/config/types.ts`
- `src/config/loader.ts`
- `.env.example`
- `src/core/usecases/engine/agent-loop.ts`
- `src/core/usecases/brain/MemoryService.ts`
- 相关配置加载、AgentLoop、MemoryService 测试及共享测试夹具

## 兼容性

- 运行时默认值仍为 `60000` 毫秒，未配置新环境变量时行为不变。
- `RuntimeLimitsConfig` 的 TypeScript 源码契约会收紧；仓库内手工构造该类型的测试夹具和调用方必须补齐两个字段。这是为了让遗漏在编译期失败，而不是继续接受不完整配置。
