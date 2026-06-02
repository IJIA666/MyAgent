## 1. 结构与类型拆离

- [x] 1.1 创建 `src/config` 目录
- [x] 1.2 创建 `src/config/types.ts` 并将所有接口（如 `LlmConfig`, `McpConfig`, `WorkspaceConfig` 等）从 `src/config.ts` 迁移至此
- [x] 1.3 创建 `src/config/models.ts`，将 `BUILTIN_MODELS` 和获取模型配置的函数迁移至此

<!-- checkpoint: npx tsc --noEmit -->

## 2. 环境与底层工具拆离

- [x] 2.1 创建 `src/config/mcp-env.ts`，将 `SAFE_ENV_WHITELIST` 和 `buildSubprocessEnv` 等子进程逻辑提取至此
- [x] 2.2 修改 `src/utils/env.ts`，将 `requireEnv` 和 `interpolateEnvVars` 等通用函数合入其中

<!-- checkpoint: npx tsc --noEmit -->

## 3. 核心加载逻辑与门面重构

- [x] 3.1 创建 `src/config/loader.ts`，将剩余的文件系统 I/O 逻辑（`loadMcpConfig`, `ensureConfigFiles`, `loadConfig` 等）提取至此，并正确引入之前的子模块
- [x] 3.2 创建 `src/config/index.ts` 作为门面（Facade），将上述所有拆分的模块通过 `export * from` 原样重新导出
- [x] 3.3 彻底删除旧的 `src/config.ts` 巨型文件，并确认所有通过 `import { ... } from './config'` 引用的外部模块（如 `index.ts`, `session.ts` 等）能够透明地从新目录中解析无误

<!-- checkpoint: npx tsc --noEmit -->
