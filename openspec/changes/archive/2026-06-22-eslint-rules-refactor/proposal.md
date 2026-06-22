## 改造原因

当前项目的 ESLint 规则配置和核心层代码实践中存在以下问题：
1. **规则白名单冗余与过度防御**：在 `eslint.config.js` 中全局关闭了测试目录下的 `no-console`，并错误地豁免了 `src/utils/logger.ts`（该文件底层使用 LogTape，其源码其实完全没有调用 console）。
2. **测试强类型契约的缺失**：测试套件全局豁免了 `@typescript-eslint/no-explicit-any` 限制，导致测试文件中滥用 `as any` 代替针对 Driven 端口（如 `VectorDbPort` 等）的强类型 mock，削弱了测试对生产代码接口变更的契约守护能力。
3. **依赖注入架构未彻底贯穿**：业务核心用例层（`src/core/usecases/` 下的会话管理、长期记忆插件、上下文存储类等）散布着 6 处直接利用行内禁用注释绕过读取 `process.env.AUTHORIZED_WORKSPACE_DIR` 全局变量的情况，破坏了系统本应由配置层（`AppConfig`）统一掌控依赖的边界，也阻碍了将来多租户/并发实例在多工作区路径下的安全隔离运行。

为了提高项目的强类型安全性、代码规范性并彻底贯彻依赖注入边界，现在需要对 ESLint 白名单规则与核心层进行一次深度的重构清理。

## 变更内容

1. **清理 ESLint 诊断白名单**：移除 `eslint.config.js` 中 logger 文件的 `no-console` 豁免，并将测试文件的 console 豁免限定在测试运行/部署相关的命令行辅助脚本（如 `test/scripts/**`）中，确保一般单元测试不被 console 逻辑污染。
2. **消灭测试 mock 中的 explicit-any**：移除测试目录下对 `@typescript-eslint/no-explicit-any` 规则的全局豁免。新增独立的测试工具辅助模块，将所有测试文件中的 `as any` 改写为符合 Driven 端口定义类型安全的 explicit 转型（`as unknown as Port`）。
3. **彻底贯彻工作区路径依赖注入**：将 `SessionManager` 的系统配置参数 `appConfig` 变更为必传参数，重构所有 8 处测试文件实例化点，通过新增的 Mock 配置工厂传入合法参数。去除业务层中所有对 `process.env.AUTHORIZED_WORKSPACE_DIR` 的直接耦合，使其完全统一消费注入的 `appConfig.workspace`。对 `ContextRepository` 的兜底重构为既保障测试目录隔离又免除 env 耦合的模式。

## 业务能力

### 新增业务能力
- eslint-rules: ESLint 配置清理与强类型注入的架构解耦规范。

### 修改业务能力
- 无：本次变更不修改任何已存在的业务能力需求规格。

## 影响范围

1. **配置文件**：
   - `eslint.config.js`：清理 override 白名单，收紧 console 例外，移去 any 豁免。
2. **业务核心与适配层**：
   - `src/core/usecases/session.ts`：构造函数 `appConfig` 改为必传，移除 3 处 process.env 的读取。
   - `src/core/usecases/LongTermMemoryPlugin.ts`：移除 1 处 process.env 的读取。
   - `src/core/usecases/ContextRepository.ts`：移除 2 处 process.env 的读取。
3. **测试套件与辅助类**：
   - `[NEW] test/mock-factory.ts`：新建测试 Mock 配置与依赖的辅助工厂文件。
   - `test/brain/plugins.test.ts`
   - `test/session/SessionManager.test.ts`
   - `test/session/loopback.test.ts`
     （批量重构测试中的 any mock 及 SessionManager 构造函数的必传参数实例化，共计 8 处实例化）
