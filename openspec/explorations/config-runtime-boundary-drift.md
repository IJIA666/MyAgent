# 探索主题: 配置契约、硬编码与运行时边界漂移

## 1. 问题定义
当前仓库的硬编码问题不是全面失控，而是呈现出“配置类型已经声明、执行层却未完全接线”的边界漂移。这类问题比单纯的常量硬编码更危险，因为它会制造“看起来可配置，实际上运行时无效”的假象，削弱系统可维护性和调试可信度。

## 2. 关键发现与调研结果
- **代码库现状**：`src/config/types.ts` 定义了 `RuntimeLimitsConfig.modelTimeoutMs` 与 `RuntimeLimitsConfig.subAgentTimeoutMs`，但 `src/config/loader.ts` 在组装 `runtimeLimits` 时没有写入这两个字段。
- **代码库现状**：执行层因此直接回落到默认值，例如 `src/core/usecases/engine/agent-loop.ts` 的 `modelTimeoutMs ?? 60000`，以及 `src/core/usecases/brain/MemoryService.ts` 的 `subAgentTimeoutMs ?? 60000`。
- **代码库现状**：`src/index.ts` 里仍存在若干基础设施判断硬编码，例如 `.agent/skills` 路径拼接、`text-embedding-v3` / `dashscope` 的字符串判断式、Embedding 适配器二选一逻辑。
- **代码库现状**：`src/core/usecases/engine/ToolDispatcher.ts` 直接写死 `.myagent/tool-outputs` 临时输出目录；`src/core/usecases/engine/agent-loop.ts` 直接写死 `en-US` 日期格式和 reminder 模板。
- **核实与洞察**：这里最优先的问题不是“常量太多”，而是配置模型与执行模型已经出现偏差。只要这种偏差存在，后续继续添加配置项就很容易变成名义配置。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 A：继续允许执行层自行 `??` 默认值兜底 | 方案 B：统一配置来源，清理假配置 | 结论 |
| :--- | :--- | :--- | :--- |
| 短期修改成本 | 低 | 中 | A 占优 |
| 运行时可预测性 | 弱 | 强 | B 占优 |
| 调试可信度 | 弱，容易误判配置生效 | 强 | B 占优 |
| 后续扩展配置能力 | 差 | 好 | B 占优 |
| 局部容错性 | 强 | 中 | A 略优 |

**推荐路径**：采用方案 B，先做“配置契约对齐”，再处理低优先级硬编码。第一优先级是保证 `types -> loader -> runtime consumer` 全链路一致；第二优先级再评估哪些路径、模板、locale、provider 选择逻辑应提升为配置或 provider 策略，哪些保留为合理默认。

## 4. 约束、风险与未知项
- 不是所有常量都应抽成配置。像内部目录名、提醒模板、默认 locale，若没有真实变更需求，过度外部化也会提高复杂度。
- 需要区分“合理默认值”和“假配置项”两类问题。前者可以保留，后者必须消除。
- Embedding provider 识别逻辑当前依赖字符串启发式，是否要进一步抽成显式 provider 配置，取决于项目是否会继续扩充非 OpenAI 兼容实现。

## 5. 否决方案
- **把所有常量一律外提成环境变量**：会制造新的配置噪音，不符合这个新项目追求简洁直接的方向。
- **忽略类型与加载器不一致，仅依赖执行层默认值兜底**：这会持续制造“声明了但不生效”的隐性缺陷，后续排查成本很高。
