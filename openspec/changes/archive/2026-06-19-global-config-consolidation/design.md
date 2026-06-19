## 背景

在先前的迭代中，为了提升系统环境的隔离性与可测试性，系统对 `loadConfig()` 引入了无副作用的依赖注入设计（接受可选的 `env` 键值字典）。
然而，目前在实现层面仍然存在未收拢的硬编码和设计穿透：
1. **工作模式加载隐式穿透**：配置装配时调用的 `loadWorkMode()` 无法感知 `loadConfig` 传入的 `env` 依赖注入字典，仍会在内部直接读取全局的 `process.env.AGENT_WORK_MODE`，从而破坏了单元测试在 Mock 环境变量时的绝对隔离。
2. **业务运行期环境变量直接触碰**：`src/config/models.ts` 的模型 payload 构建逻辑（`buildExtraPayload`）在运行时直接访问了 `process.env.DEEPSEEK_REASONING_EFFORT`，使该静态逻辑掺杂了运行期的全局状态，不利于多实例独立配置与单元测试 Mock。

为了解决上述问题，本设计决定采用**纯依赖注入 (Dependency Injection)** 的方式，将全部环境变量的生命周期收归到启动装配期，并通过 ESLint 规则在物理层面上阻断业务代码直接读取全局 `process.env` 的可能。

## 目标与非目标

**目标:**
- **类型契约加固与 Fail-Fast**：在 `LlmConfig` 中增加 `reasoningEffort` 显式属性，并在 `loadConfig` 的装配阶段完成值域的 Fail-Fast 校验。`[Amend 修正]`：如果环境变量未配置（即为 `undefined` 或空字符串），应判定为合法放行，仅当有明确且非法的值时抛出异常。
- **物理拦截引入**：配置 ESLint 的环境校验规则，通过代码静态检查和 CI 门禁，强制阻断业务代码对全局 `process.env` 的直接访问。`[Amend 修正]`：由于原生 `no-process-env` 规则已在较新版本 ESLint 中被弃用，首选依赖 `eslint-plugin-n` 的 `n/no-process-env` 规则，确保物理卡关能够真实生效。

**非目标:**
- **不重构与环境变量无关的业务逻辑**：不改动 `Session` 执行流、命令白名单匹配规则等非核心配置加载组件。
- **不删除 AUTHORIZED_WORKSPACE_DIR 的安全保障**：保留 `loader.ts` 中针对靶场自动化测试重定向的隐式读取逻辑及醒目的安全注释警示，也不删除已有的单元测试验证逻辑。

## 架构决策

### 决策一：选择 Scheme B（纯依赖注入）而不是 Scheme A（单例持有器）
- **原因**：
  - **支持多实例并发**：全局配置持有器（Config Holder）本质上是全局状态，会锁死进程的配置能力，导致在同进程内并发拉起多个不同配置的 Agent 实例时发生配置相互覆盖与污染。纯依赖注入能够保证各实例相互独立。
  - **消除测试竞态**：并发运行单元测试时，如果依赖全局状态重置（`resetConfig`），极易发生由于竞态条件（Race Condition）而导致的偶发性单测失败。依赖注入不需要任何全局状态清理，天生支持高并发单测。
  - **架构长期健康度**：新项目无向后兼容历史包袱，理应在早期直接采用最纯净的 DI 模式。
- **实现方式**：
  - 运行时所需要的配置仅通过参数显式传入。
  - 为防止过度重构带来的侵入性，遵循**“按需局部注入”**原则：
    - `[Amend 修正]`：为了防止通用接口被特定模型的专有概念（如 `reasoningEffort`）污染，必须保持大模型通用适配契约（`ModelProfile`）的开闭原则。大模型特定的 payload 生成逻辑 `buildExtraPayload` 的签名改造为接收通用配置对象 `LlmConfig`：
      ```typescript
      buildExtraPayload?: (options?: Record<string, unknown>, config?: LlmConfig) => Record<string, unknown>;
      ```
      驱动层 `driver.ts` 在调用时直接无脑透传 `this.llmConfig`：`model.buildExtraPayload(options, this.llmConfig)`，由底层具体模型（如 DeepSeek 模型）在实现内部解构并生成特化载荷参数。

### 决策二：重构 `loadWorkMode` 实现彻底的依赖注入
- **修改**：
  - `loadWorkMode` 的签名重构为：
    ```typescript
    export function loadWorkMode(env: Record<string, string | undefined> = process.env): WorkMode
    ```
  - 内部将对 `process.env.AGENT_WORK_MODE` 的直接访问全部重路由到 `env.AGENT_WORK_MODE` 上。
  - 在 `loader.ts` 中，`const workMode = loadWorkMode(env);` 显式传入 `env` 字典。

### 决策三：ESLint 物理阻断网（物理阻断机制）
- **说明**：`[Amend 修正]` 规则名应根据 ESLint 实际环境支持进行配置。在根目录 `eslint.config.js` 中引入 `eslint-plugin-n`，并将规则配置为 `"n/no-process-env": "error"`。
- **受控例外**：
  - 仅允许在 `src/config/loader.ts`、`test/config/loader.test.ts` 以及必要的本地编译/辅助脚本中通过行级注释 `/* eslint-disable no-process-env */`（或 `/* eslint-disable n/no-process-env */`）绕过规则。
  - 任何其他业务代码或 Native Tools 代码一旦包含 `process.env` 读取且未提供显式例外，将在 lint 检查或 CI 时直接报错阻断合入。

## 风险与权衡

- **[风险点] 改造范围扩散风险**  
  -> **缓解策略**：`[Amend 修正]`：重构严格限制在“局部配置对象参数传递”。例如：`buildExtraPayload` 仅扩充接收 `LlmConfig` 通用对象，修改调用它的 `driver.ts` 以透传 `this.llmConfig`，不向最底层方法透传整个庞大的 `AppConfig`。
- **[风险点] ESLint 对单元测试的阻碍**  
  -> **缓解策略**：`[Amend 修正]`：针对需要暂存并修改全局 `process.env` 的测试用例，在测试文件的头部或用例上方，局部添加 ESLint 例外注释（如 `/* eslint-disable n/no-process-env */`），确保单测编写体验不受负面影响，且规则的强约束对开发者清晰可见。
