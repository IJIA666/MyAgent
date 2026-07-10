## 背景

`RuntimeLimitsConfig.modelTimeoutMs` 与 `RuntimeLimitsConfig.subAgentTimeoutMs` 当前是可选字段，`loadConfig()` 组装 `runtimeLimits` 时没有赋值。对应消费方因此各自使用 `?? 60000`：

- `agent-loop.ts` 用 `modelTimeoutMs` 限制单次模型请求；
- `MemoryService.ts` 用 `subAgentTimeoutMs` 限制后台自省子智能体的总执行时间。

这不是“所有硬编码都需要配置化”的问题，而是同一配置契约在类型、装配和消费三个环节不一致。

## 目标与非目标

**目标：**

1. 让两个超时字段由 `loadConfig()` 统一装配，并支持环境变量覆盖。
2. 保持未配置时的现有 `60000` 毫秒行为。
3. 通过必填类型约束，让后续漏装配在编译期暴露。
4. 消除两个消费点对超时默认值的重复定义，并验证配置值确实到达消费方。

**非目标：**

- 不建立从 TypeScript 接口反射运行时字段的校验器。
- 不整治 `.myagent/tool-outputs`、日期 locale、system-reminder 模板或其他魔法字面量。
- 不调整 `AGENT_LLM_TIMEOUT` 所控制的底层 OpenAI 客户端网络超时；它与本 change 的 AgentLoop 单次调用超时是不同边界。
- 不重构 `SessionContext` 的整体构造与恢复生命周期。

## 架构决策

### 决策 1：使用必填类型形成编译期装配约束

将 `modelTimeoutMs`、`subAgentTimeoutMs` 从可选字段改为必填字段。`loadConfig()` 中的配置对象已显式标注为 `AppConfig`，因此加载器或测试夹具漏掉字段时，TypeScript 会直接报错。

不采用“运行时比较接口字段集”的方案。TypeScript 接口在编译后会被擦除；若要运行时比较，必须额外维护 schema 或字段清单，而双份元数据本身又会产生新的漂移来源。当前两个数值字段不值得引入该复杂度。

### 决策 2：加载器是超时默认值的唯一来源

`loadConfig()` 在现有整数解析逻辑之上增加定时器范围约束，只接受 `1` 到 `2147483647` 毫秒：

| 配置字段 | 环境变量 | 默认值 |
| :--- | :--- | :--- |
| `modelTimeoutMs` | `AGENT_MODEL_TIMEOUT_MS` | `60000` |
| `subAgentTimeoutMs` | `AGENT_SUB_AGENT_TIMEOUT_MS` | `60000` |

缺失、空白、无法解析、非正数或超出 Node.js 定时器安全范围的值均回落到默认值，避免 `AbortSignal.timeout()` 抛出范围错误或 `setTimeout()` 发生溢出。

两个新环境变量不复用 `AGENT_LLM_TIMEOUT`。后者配置的是 OpenAI 客户端网络请求超时，默认值为 10 分钟；`modelTimeoutMs` 则是 AgentLoop 在单次调用外层创建的取消时限，二者生命周期和默认值均不同。

### 决策 3：消费方区分“配置值缺失”和“配置对象未注入”

`MemoryService` 的构造函数已要求传入 `AppConfig`，因此可直接读取必填字段。

`SessionContext.appConfig` 在类型上仍可为空，因为上下文允许先构造、后由 `Session` 注入配置。`AgentLoop` 到达模型调用边界时，配置应已完成注入；若不满足该不变量，应抛出明确的初始化错误，而不是再次回落到 `60000`。实现时使用显式检查，不使用非空断言隐藏生命周期错误。

### 决策 4：硬编码议题保持独立

`.myagent/tool-outputs` 已由 `tool-output-offloading` 基线 spec 明确规定；locale 与 system-reminder 当前位于 `model-request-assembler.ts`，也不属于本次超时配置链路。将它们纳入同一个 change 会形成多个可独立评审、独立验收的目标，因此本次不处理。

## 风险与缓解

| 风险 | 缓解策略 |
| :--- | :--- |
| 必填字段导致现有测试夹具编译失败 | 枚举所有手工构造的 `RuntimeLimitsConfig` / `AppConfig`，统一补齐两个字段 |
| 新环境变量名与 `AGENT_LLM_TIMEOUT` 含义混淆 | 在 `.env.example` 中分别说明外层调用超时、后台总超时与底层网络超时的差异 |
| AgentLoop 在未注入配置时从静默兜底变为失败 | 使用明确错误信息暴露初始化顺序缺陷，并增加对应测试 |
| 自定义值未真正传到消费方 | 分别在 loader、AgentLoop、MemoryService 的定向测试中验证传递结果 |
