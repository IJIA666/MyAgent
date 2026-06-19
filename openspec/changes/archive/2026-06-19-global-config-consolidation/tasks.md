## 1. 契约定义与环境校验准备

- [x] 1.1 修改 `src/config/types.ts`，在 `LlmConfig` 接口中扩展 `reasoningEffort?: string` 可选强类型字段，并按标准编写 JSDoc/TSDoc 注释。
- [x] 1.2 修改 `src/config/loader.ts` 中的 `loadConfig` 函数，增加对 `env.DEEPSEEK_REASONING_EFFORT` 环境变量的提取与 Fail-Fast 值域校验（若未配置即为 `undefined` 或空字符串，判定为合法放行；仅当有明确值且不在 `'high' | 'medium' | 'low' | 'disabled'` 范围内时才抛出异常）。

<!-- checkpoint: npm run build -->

## 2. 依赖注入与签名重构

- [x] 2.1 重构 `src/action/native-tools/terminal-config.ts` 中的 `loadWorkMode` 函数签名，使其能够接收可选的环境变量字典参数 `env: Record<string, string | undefined> = process.env`。将内部所有 `process.env.AGENT_WORK_MODE` 直接替换为对该参数的读取。
- [x] 2.2 修改 `src/config/loader.ts`，在调用 `loadWorkMode` 时将 `env` 变量显式传入：`loadWorkMode(env)`。
- [x] 2.3 修改 `src/config/types.ts` 和 `src/config/models.ts` 中的 `ModelProfile` 接口定义，重构 `buildExtraPayload` 签名使其接受配置对象参数：`buildExtraPayload?: (options?: Record<string, unknown>, config?: LlmConfig) => Record<string, unknown>;`。
- [x] 2.4 在 `src/config/models.ts` 中重构内置模型定义的 `buildExtraPayload` 方法，使其接受传入的 `config` 并在其内部解构 `config.reasoningEffort`（兜底为 `'high'`）生成特化载荷，彻底剥离其内部对 `process.env` 的直接读取，保持模型适配契约的纯洁性。
- [x] 2.5 修改 `src/brain/driver.ts` 中所有调用 `buildExtraPayload` 的地方，直接透传整个配置对象：`model.buildExtraPayload(this.modelOptions, this.llmConfig)`。

<!-- checkpoint: npm run build && vitest run -->

## 3. ESLint 物理阻断网配置

- [x] 3.1 修改根目录下的 `eslint.config.js`，引入 `eslint-plugin-n`，在 `rules` 中配置 `"n/no-process-env": "error"` 规则以防原生规则失效，并在配置前先确认当前 ESLint 插件体系以确保配置能够生效。
- [x] 3.2 针对项目中必须特许例外的物理交互文件（如 `src/config/loader.ts`、`test/config/loader.test.ts` 以及系统初始化/评测脚本），在文件头部或对应语句上方添加 `/* eslint-disable n/no-process-env */` 例外注释，其余逻辑禁止触碰全局变量。

<!-- checkpoint: npm run lint -->

## 4. 单元测试更新与隔离性验证

- [x] 4.1 在 `test/config/loader.test.ts` 中补充针对环境变量依赖注入绝对隔离性的 Vitest 单元测试，验证向 `loadConfig(env)` 注入 Mock 环境时，`loadWorkMode` 和 `reasoningEffort` 不会穿透读取真实的物理全局环境变量。

<!-- checkpoint: vitest run -->
