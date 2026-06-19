## 改造原因

在先前的系统加固与模块化重构中，系统确立了“配置解析无副作用化与依赖注入”的架构规范。然而，在目前的环境变量使用中，系统仍存在以下硬编码与依赖穿透漏洞：
- **硬编码与逻辑混杂**：部分非初始化文件（如 `src/config/models.ts` 中的 `buildExtraPayload`）在运行时直接读取 `process.env.DEEPSEEK_REASONING_EFFORT`；而 `src/action/native-tools/terminal-config.ts` 中的 `loadWorkMode` 在兜底时依然读取 `process.env.AGENT_WORK_MODE`。这种魔术字段的散落绕过了统一的配置装配与校验层。
- **环境隔离性破坏（致命）**：`loadConfig(env)` 虽提供了 `env` 注入，但由于其内部调用的 `loadWorkMode()` 签名不接受 `env` 参数，导致在单元测试注入 Mock 字典时，底层仍穿透读取全局的 `process.env.AGENT_WORK_MODE` 和磁盘物理配置文件，这破坏了单测的纯净隔离性，阻碍了未来多 Agent 实例在同进程内的并发独立运行。
- **Fail-Fast机制缺失**：由于配置在运行时动态按需分散获取，系统无法在启动生命周期的最前端完成全部必要的格式校验，容易引发隐蔽的安全配置失效。

因此，亟需通过纯依赖注入（Dependency Injection）的路径将所有环境变量及运行期参数完全收拢到配置加载器 `loader.ts`，并配合 ESLint 在物理层面阻断对 `process.env` 的直接读取，以维持系统的长期高内聚与多实例高并发扩展性。

## 变更内容

本变更主要是纯技术重构与规范加固，不涉及不兼容的业务接口变更（No BREAKING changes），具体变更如下：
- **依赖注入彻底化**：重构 `loadWorkMode` 函数签名使其接受 `env` 注入参数，并修改 `loadConfig` 透传调用。
- **配置契约扩展**：在 `LlmConfig` 接口定义中扩展 `reasoningEffort` 强类型可选字段，并在 `loadConfig` 中对其进行 Fail-Fast 提取与值域合法性校验。
- **参数透传重构**：修改大模型 `buildExtraPayload` 函数签名以接受通用配置对象 `LlmConfig` 参数。修改大模型驱动 `driver.ts` 以从局部配置中直接透传该对象，彻底剥离业务运行期读取 `process.env` 的行为，保持模型适配契约的纯洁度。
- **静态物理阻断**：在 `eslint.config.js` 中引入 `no-process-env` 规则，仅对 `loader.ts`、测试等极少数基础物理 IO 层例外，其余业务代码若触碰 `process.env` 将在编译与 CI 门禁期强制报错。

## 业务能力

### 新增业务能力
- `config-physical-blockade`: 引入 ESLint 静态代码安全门禁，在编译和 CI 阶段物理阻断业务与工具链代码直接读取全局 `process.env` 的可能。

### 修改业务能力
- 无：本次变更未修改已有的产品功能性业务需求（不涉及 spec 层面的产品行为变更）。

## 影响范围

- **受影响的代码文件**：
  - [types.ts](file:///d:/Projects/MyAgent/src/config/types.ts)（扩展接口定义）
  - [loader.ts](file:///d:/Projects/MyAgent/src/config/loader.ts)（装配与 Fail-Fast 校验）
  - [models.ts](file:///d:/Projects/MyAgent/src/config/models.ts)（模型静态配置及 payload 生成签名重构）
  - [terminal-config.ts](file:///d:/Projects/MyAgent/src/action/native-tools/terminal-config.ts)（签名改造）
  - [driver.ts](file:///d:/Projects/MyAgent/src/brain/driver.ts)（参数透传）
  - [eslint.config.js](file:///d:/Projects/MyAgent/eslint.config.js)（规则配置）
- **受影响的单元测试**：
  - [loader.test.ts](file:///d:/Projects/MyAgent/test/config/loader.test.ts) 等涉及配置加载的测试用例。
- **系统依赖**：无新增的第三方 npm 依赖。
