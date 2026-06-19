## 改造原因

在大语言模型集成与通用 Agent 的架构演进中，系统当前存在两个严重的技术债：
1. **环境变量供应商前缀锁定 (Vendor Lock-in)**：环境变量硬编码了 `DEEPSEEK_` 前缀（如 `DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL`）。这不仅对接入 Ollama、vLLM、OpenAI 或 Claude 等其他模型产生严重的认知撕裂，也扼杀了未来多模型并发路由与混合驱动的扩展空间。
2. **校验逻辑混杂与类型系统脱节**：推理努力度（思考等级）`reasoningEffort` 在内部没有建立只读常量数组与强类型的联动约束，且校验逻辑直接硬编码在通用的 `loader.ts` 中，污染了通用加载器，违反了职责单一原则。

为了实现真正的供应商中立（Vendor-Neutral）和高扩展性的配置系统，本次变更将全面进行前缀去厂商化泛化重构，并在类型系统和加载层上实现高内聚、高解耦。

## 变更内容

本变更属于重要的架构契约重构，包含以下不兼容的配置项变更（**BREAKING CHANGES**）：
1. **配置接口命名空间去厂商化**：将所有 `DEEPSEEK_` 前缀的环境变量重构为泛化的 `AGENT_LLM_` 命名空间。
   - `DEEPSEEK_API_KEY` -> `AGENT_LLM_API_KEY`
   - `DEEPSEEK_API_URL` -> `AGENT_LLM_BASE_URL`
   - `DEEPSEEK_MODEL` -> `AGENT_LLM_MODEL`
   - `DEEPSEEK_MAX_TOKENS` -> `AGENT_LLM_MAX_TOKENS`
   - `DEEPSEEK_REASONING_EFFORT` -> `AGENT_LLM_REASONING_EFFORT`
   - 以及 `CONTEXT_WINDOW`、`TEMPERATURE`、`TIMEOUT`、`MAX_RETRIES`、`HEADERS` 等高级配置同样更新为 `AGENT_LLM_` 前缀。
2. **SSOT 类型对齐**：在 `types.ts` 中声明只读常量数组 `VALID_REASONING_EFFORTS = ['low', 'medium', 'high', 'max', 'disabled'] as const` 并据此推导字面量联合类型 `ReasoningEffort`。
3. **校验职责下放**：将推理努力度的校验逻辑彻底下放到 `models.ts` 的 `getModelConfig` 中，净化通用加载器。
4. **单测与配套指令调整**：级联更新模型切换指令、单测及配置文件模板。

## 业务能力

### 新增业务能力
- 无：本次不新增额外的业务能力，主要是配置接口规范的调整与重构。

### 修改业务能力
- `config-management`: 环境变量的装配、校验规范和修改写入契约，由特定的 DeepSeek 厂商前缀泛化为通用的 Agent 环境变量。
- `context-compaction`: 自适应窗口大小和覆写参数时，所引用的环境变量前缀由 `DEEPSEEK_` 替换为 `AGENT_LLM_`。

## 影响范围

- **配置文件**：`.env`、`.env.example`。
- **配置与模型层代码**：`src/config/types.ts`、`src/config/models.ts`、`src/config/loader.ts`。
- **CLI 指令代码**：`src/interface/commands/model.ts`。
- **辅助函数代码**：`src/utils/env.ts`。
- **单元测试文件**：`test/config/loader.test.ts`、`test/brain/models.test.ts`。
