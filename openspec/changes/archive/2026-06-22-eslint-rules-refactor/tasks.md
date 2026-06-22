## 1. ESLint 白名单与全局豁免规则清理

- [x] 1.1 修改 [eslint.config.js](file:///d:/Projects/MyAgent/eslint.config.js)，移去 `src/utils/logger.ts` 在 `no-console: off` 的例外白名单；
- [x] 1.2 修改 [eslint.config.js](file:///d:/Projects/MyAgent/eslint.config.js)，将测试的 `no-console` 例外白名单由 `test/**/*.ts` 缩窄为仅限于 `test/scripts/**/*.ts`；
- [x] 1.3 修改 [eslint.config.js](file:///d:/Projects/MyAgent/eslint.config.js)，移除测试目录下 `@typescript-eslint/no-explicit-any: off` 的全局豁免，激活 strict 强类型校验。

<!-- checkpoint: npm run lint -->

## 2. 共享 Mock 辅助工厂与测试 any 消除

- [x] 2.1 新建共享测试辅助模块 [test/mock-factory.ts](file:///d:/Projects/MyAgent/test/mock-factory.ts)，声明 `createMockAppConfig(custom?: Partial<AppConfig>): AppConfig`。其默认 `workspace` 绑定为 `process.env.AUTHORIZED_WORKSPACE_DIR || process.cwd()`；
- [x] 2.2 重构 [plugins.test.ts](file:///d:/Projects/MyAgent/test/brain/plugins.test.ts)，消除 `as any`，将私有方法 spy 改为强类型转型，并提前使用 `createMockAppConfig()` 改写 2 处 `SessionManager` 实例化；
- [x] 2.3 重构 [SessionManager.test.ts](file:///d:/Projects/MyAgent/test/session/SessionManager.test.ts)，消除所有 `as any`，并提前使用 `createMockAppConfig()` 改写 5 处 `SessionManager` 实例化；
- [x] 2.4 重构 [loopback.test.ts](file:///d:/Projects/MyAgent/test/session/loopback.test.ts)，消除 `as any`，并提前使用 `createMockAppConfig()` 改写 1 处 `SessionManager` 实例化。

<!-- checkpoint: npm run lint -->

## 3. 业务层贯穿依赖注入与测试装配修复

- [x] 3.1 重构 [session.ts](file:///d:/Projects/MyAgent/src/core/usecases/session.ts)，将构造函数参数 `appConfig` 变更为必传参数 (`appConfig: AppConfig`)，内部工作区解析直接读取 `appConfig.workspace`。清理 3 处 process.env 的读取 and 相应的禁用注释；
- [x] 3.2 重构 [LongTermMemoryPlugin.ts](file:///d:/Projects/MyAgent/src/core/usecases/LongTermMemoryPlugin.ts)，将内部 memoryFilePath 的默认工作路径取值去环境化，移除对 `process.env.AUTHORIZED_WORKSPACE_DIR` 的直接读取并清理禁用注释；
- [x] 3.3 重构 [ContextRepository.ts](file:///d:/Projects/MyAgent/src/core/usecases/ContextRepository.ts)，将获取 `baseDir` 时的退化路径改写为 `this.workspacePath || this.context.appConfig?.workspace || process.cwd()`，彻底消除对 `process.env` 的直接耦合并清理禁用注释；

<!-- checkpoint: npm run test -->
