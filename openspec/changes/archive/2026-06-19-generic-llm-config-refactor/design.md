## 背景

当前系统的配置解析采用了无副作用化与依赖注入的设计，但配置中的具体字段和环境变量定义带有很强的 DeepSeek 厂商色彩（如 `DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL`）。在底层的 `models.ts` 中直接硬编码了这些厂商变量名，并且 `loader.ts` 耦合了推理努力度（`DEEPSEEK_REASONING_EFFORT`）的解析与校验。这种设计阻碍了未来的多模型接入，且存在配置与静态类型系统的脱节。

## 目标与非目标

**目标:**
1. **环境变量去厂商化泛化**：将所有 `DEEPSEEK_` 前缀的环境变量变更为通用的以 `AGENT_LLM_` 为前缀的环境变量，实现配置层的厂商中立。
2. **SSOT 类型保障**：在 `types.ts` 中定义 `VALID_REASONING_EFFORTS` 常量，通过反向推导确定 `ReasoningEffort` 强类型，消除代码中多处硬编码的值域判断。
3. **加载器解耦**：将推理努力度的具体值域校验与提取逻辑从 `loader.ts` 中彻底剥离，移入 `models.ts` 的模型 Profile 工厂函数 `getModelConfig` 中。
4. **单测及周边闭环**：使现有的 52 个测试用例和 ESLint 卡关在重构后依然全部通过，并且 `updateEnvVariable` 机制完美支持修改后的环境变量前缀。

**非目标:**
1. **多模型混合路由与运行时并发调度**：本次只完成配置接口与命名空间的泛化重构，不在本 Change 中增加多模型并发调用的业务逻辑。
2. **兼容历史 DEEPSEEK_ 前缀环境变量**：坚决不设计自动向下兼容的双前缀解析机制，保证系统的单一数据源（SSOT）与清澈度。

## 架构决策

### 决策一：反向推导强类型（SSOT）
- **实现细节**：在 `types.ts` 中声明：
  ```typescript
  export const VALID_REASONING_EFFORTS = ['low', 'medium', 'high', 'max', 'disabled'] as const;
  export type ReasoningEffort = typeof VALID_REASONING_EFFORTS[number];
  ```
  并在 `LlmConfig.reasoningEffort` 属性上声明为 `ReasoningEffort` 类型。
- **理由**：通过这种方式，运行时的校验数组（`VALID_REASONING_EFFORTS`）与 TypeScript 编译期的静态类型保障紧密联动。若未来增加任何推理等级（如 `xhigh`），只需在一个位置（`VALID_REASONING_EFFORTS` 常量数组）进行扩展，即可级联到所有类型定义和逻辑分支中，消除了魔法数组。

### 决策二：配置值域校验下放到 models.ts
- **实现细节**：`loader.ts` 中的 `loadConfig` 仅负责获取 `env.AGENT_LLM_MODEL`（若无则兜底为 `'deepseek-v4-flash'`）并解析基本模型 ID，随后将 `env` 透传给 `getModelConfig`。具体的推理努力度（`env.AGENT_LLM_REASONING_EFFORT`）读取、以及基于 `VALID_REASONING_EFFORTS` 的值域 Fail-Fast 校验逻辑，完全封装在 `models.ts` 的 `getModelConfig` 内部。
- **理由**：`loader.ts` 属于通用的全局配置管理器，不应该感知具体模型是否支持“思考努力度”以及它的校验边界。将其移入 `models.ts` 可以让 `loader` 恢复通用中立，并遵循开闭原则。

### 决策三：命名空间替换 AGENT_LLM_
- **实现细节**：全面替换 `DEEPSEEK_` 为 `AGENT_LLM_`。例如 `DEEPSEEK_API_KEY` 替换为 `AGENT_LLM_API_KEY`，`DEEPSEEK_MODEL` 替换为 `AGENT_LLM_MODEL` 等。
- **理由**：采用统一的 `AGENT_LLM_` 作为前缀可以完美融入现有的 `AGENT_WORK_MODE` 等前缀规范，确保系统在被本地模型或第三方兼容端点托管时，用户体验上不存在任何品牌认知割裂。

## 风险与权衡

### 风险点：不兼容变更（Breaking Change）导致用户连接失效
- **描述**：由于系统不再向后兼容 `DEEPSEEK_` 前缀，重构完成后如果用户直接更新代码，可能会因为本地的旧 `.env` 文件没有修改而导致运行报错（由于找不到 `AGENT_LLM_API_KEY` 抛出 `Error`）。
- **缓解策略**：
  - 在 `models.ts` 的 `getModelConfig` 中，当 `env[profile.envKeyName]` (即 `env.AGENT_LLM_API_KEY`) 为空或不存在时，抛出的错误日志必须极度醒目且具有指导性：
    `throw new Error(`缺失模型 ${id} 的 API Key: 请在 .env 中配置 ${profile.envKeyName}`);`
  - 自动更新工作区根目录的 `.env.example` 模板文件，并在用户更新工程时，如果检测到不存在 `.env` 会自动复制。
  - 在归档总结和提交日志中突出强调此 Breaking Change。
