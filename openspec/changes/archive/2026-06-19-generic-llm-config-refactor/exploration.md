# 探索主题: 大模型连接配置前缀泛化与 SSOT 类型联动重构

## 1. 问题定义
在构建通用 Agent 助手时，系统的环境变量配置接口以及内部的配置处理机制面临以下两个关键瓶颈：
- **配置接口的供应商锁定 (Vendor Lock-in)**：环境变量硬编码了 `DEEPSEEK_` 前缀，当系统计划适配多模型路由（例如同时结合 OpenAI, Anthropic 等）或使用本地私有部署模型时，给用户带来了严重的认知撕裂。
- **单一数据源原则 (SSOT) 破坏与类型脱节**：思考等级 `reasoningEffort` 在系统中作为字面量字段被散落在多处验证和错误信息中，没有建立只读常量数组与强类型的联动约束，且校验逻辑直接硬编码在通用的 `loader.ts` 中，污染了通用接口契约的纯洁性。

本探索旨在通过“前缀泛化（去厂商化）”以及“单一数据源静态类型联动（SSOT）”来彻底解决上述技术债。

## 2. 关键发现与调研结果
- **代码库现状**：
  - [loader.ts](file:///d:/Projects/MyAgent/src/config/loader.ts) 耦合了 `DEEPSEEK_` 环境变量前缀，且直接在其中校验 `DEEPSEEK_REASONING_EFFORT` 的合法值域。
  - [models.ts](file:///d:/Projects/MyAgent/src/config/models.ts) 中定义的 `BUILTIN_MODELS` 特化配置把 `envKeyName` 和 `envUrlName` 写死为了厂商特有变量名（`DEEPSEEK_API_KEY`, `DEEPSEEK_API_URL`）。
  - [types.ts](file:///d:/Projects/MyAgent/src/config/types.ts) 中的 `reasoningEffort` 是宽松的 `string` 类型，运行时的校验数组 `['low', 'medium', 'high', 'max', 'disabled']` 在 `loader.ts` 内部手动写死，与 TypeScript 静态类型系统脱节。
  - 单测 [loader.test.ts](file:///d:/Projects/MyAgent/test/config/loader.test.ts) 和 [models.test.ts](file:///d:/Projects/MyAgent/test/brain/models.test.ts) 直接依赖于对 `DEEPSEEK_` 全局环境变量的注入。
- **核实与洞察**：
  - 经联网检索核实，OpenAI 官方已在 o1/o3-mini 等推理模型中标准化了 `reasoning_effort` 参数（可选值为 `low`, `medium`, `high`）。
  - 提取公共词汇“推理努力度”或“思考预算”作为通用抽象是完全可行的，底层的驱动适配器可分别将其翻译给具体模型（例如 DeepSeek 翻译为 `thinking` 和 `reasoning_effort`，OpenAI 翻译为 `reasoning_effort`，Anthropic 翻译为 `thinking` 预算）。

## 3. 方案对比与推荐方向

| 评估维度 | 方案 A (保持现状) | 方案 B (厂商前缀泛化与类型重构) | 结论 |
| :--- | :--- | :--- | :--- |
| **开闭原则遵循度** | 差 ✗ (每增一个厂商都需要去 loader.ts 改 if-else) | 优秀 ✓ (校验下放到 Profile，支持灵活扩展) | 方案 B 占优 |
| **用户体验与认知** | 差 ✗ (使用 Ollama/OpenAI 时却要配 `DEEPSEEK_` 键名) | 优秀 ✓ (采用通用的 `AGENT_LLM_` 命名空间) | 方案 B 占优 |
| **类型系统保障** | 弱 ✗ (使用 `string` 类型，拼写错误无法在编译期拦截) | 强 ✓ (基于常量只读数组反向推导强字面量联合类型) | 方案 B 占优 |
| **向下兼容性** | 完美 ✓ (已有 `.env` 无需改动) | 需用户迁移 ✗ (用户需将 `.env` 的厂商前缀更新) | 方案 A 占优 |

**推荐路径**：
尽管方案 B 会带来一次对 `.env` 环境变量名的不兼容迁移（属于向前兼容性突破），但由于本项目是一个尚无沉重历史包袱的全新 Agent 项目，应尽早清退这类反模式技术债。
因此，我们推荐采用 **方案 B (去厂商化前缀泛化与类型重构)**。

## 4. 约束、风险与未知项
- **未及时更新 `.env` 的风险**：当用户更新了最新版代码，如果本地 `.env` 仍旧为 `DEEPSEEK_API_KEY` 等，系统会在启动时立刻 Fail-Fast 并明确抛出 `缺失模型 deepseek-v4-flash 的 API Key: 请在 .env 中配置 AGENT_LLM_API_KEY` 的报警。必须确保报错提示清晰易懂，减少开发者排查成本。

## 5. 否决方案
- **自动兼容 fallback 方案（即同时支持 DEEPSEEK_ 和 AGENT_LLM_）**：
  - *否决原因*：这会导致加载层代码复杂度翻倍，使得原有的代码“配置接口污染”得不到彻底根治，开发人员依然会在代码库中看到多套命名的混合使用，不利于类型收拢和接口洁癖的推行。
