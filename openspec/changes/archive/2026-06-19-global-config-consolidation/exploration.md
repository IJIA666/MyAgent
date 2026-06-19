# 探索主题: 全局配置与环境变量体系收拢

## 1. 问题定义
目前，应用在环境变量的使用上存在典型的“魔术字段”乱象：
- **配置与逻辑混杂**：非初始化文件（如 `models.ts`、`terminal-config.ts`）直接在业务运行期调用 `process.env` 读取环境变量（如 `DEEPSEEK_REASONING_EFFORT`、`AGENT_WORK_MODE`），绕过了统一的配置装配与校验层。
- **Fail-Fast机制缺失**：由于环境变量的分散动态获取，系统无法在启动生命周期的最前端完成全部必要的格式校验，增加了隐蔽的安全配置失效风险。

本探索旨在设计一套将所有环境变量集中收归到 `AppConfig` 契约，并实现运行期强类型防篡改的技术方案。

## 2. 关键发现与调研结果
- **代码库现状**：
  - **现有配置结构**：核心配置装配在 `src/config/loader.ts` 中的 `loadConfig()` 进行，目前仅组装了 `llm`、`workspace`、`mcp` 和 `workMode` 属性。
  - **硬编码散落点**：`src/config/models.ts` 在 `buildExtraPayload` 中直接读取了 `process.env.DEEPSEEK_REASONING_EFFORT`；`src/action/native-tools/terminal-config.ts` 在 `loadWorkMode` 中直接读取了 `process.env.AGENT_WORK_MODE`。
  - **依赖注入不彻底问题**：配置加载器 `loadConfig(env)` 虽已支持 `env` 环境变量对象依赖注入，但其调用的 `loadWorkMode()` 签名不接受 `env`。这导致 `loadWorkMode` 在兜底时依然强行读取全局 `process.env.AGENT_WORK_MODE`，并伴随物理磁盘文件读取。这使得在单元测试中注入 Mock 的 `env` 也会穿透读取真实环境，破坏了用例之间的隔离性。
  - **循环依赖关系**：`loader.ts` 导入了 `models.ts` 和 `terminal-config.ts` 进行配置组装。若后两者反向从 `loader.ts` 导入配置，将形成 `loader -> terminal-config -> loader` 的物理循环依赖（Circular Dependency）。
- **规避方案调研**：
  - **轻量配置持有器（Config Holder）**：定义一个不含任何业务依赖的极简单例模块专门持有已初始化的 `AppConfig`，供各模块读取。该方案对于“单进程多 Agent 实例并发运行”的扩展性存在致命缺陷，且在并发单元测试中会由于全局状态争抢导致竞态条件（Race Condition）。
  - **显式依赖注入（Dependency Injection）**：重构业务函数或类，使它们不再依赖全局状态，配置仅通过参数显式注入。该方案能够实现 100% 绝对安全的测试隔离，支持多 Agent 实例在同进程内的并发独立运行。

## 3. 方案对比与重构方向
| 评估维度 | 方案 A (配置持有器单例 - Config Holder) | 方案 B (纯依赖注入 - Dependency Injection) | 结论 |
| :--- | :--- | :--- | :--- |
| **循环依赖风险** | **极低 ✓**（业务模块仅依赖极简的 holder，不依赖 loader 逻辑） | **零 ✓**（完全解耦，无全局变量引用） | 方案 B 占优 |
| **业务改造侵入性** | **极低 ✓**（仅需替换为读取单例，爆炸半径小） | **高 ✗**（需要修改函数签名和类构造器，但可通过局部注入缓解） | 方案 A 占优 |
| **多实例高并发扩展** | **无 ✗**（全局单例锁死状态，多实例会发生配置覆盖与污染） | **极高 ✓**（完全独立，支持多实例独立配置） | 方案 B 占优 |
| **测试隔离性（并发）** | **低 ✗**（必须全局重置，且在并发跑单测时极易发生竞态失败） | **极高 ✓**（100% 独立，测试用例之间绝无干扰） | 方案 B 占优 |
| **代码维护心智** | **低**（随着项目成长容易积攒 Singleton 技术债） | **极高 ✓**（无全局状态，符合函数式纯净性，促使单一职责） | 方案 B 占优 |

**推荐路径**：
秉持“新项目无包袱，直接采用架构最优解”的原则，**最终确定采用 方案 B (纯依赖注入)** 进行重构。
虽然修改函数签名存在一定的重构工作量，但通过**“按需传递局部配置”**（例如：模型特定 payload 生成仅接收 `reasoningEffort` 局部属性或 `LlmConfig`，不渗透庞大的 `AppConfig`）可以极大缓解侵入性带来的心智负担，并且在多实例并发、测试隔离及架构纯洁性方面具有无可比拟的长期优势。

## 4. 改进策略与落地设计
- **依赖注入彻底化**：重构 `loadWorkMode` 的函数签名，使其能够接收局部变量 `env`：
  ```typescript
  export function loadWorkMode(env: Record<string, string | undefined> = process.env): WorkMode
  ```
  并在 `loader.ts` 的 `loadConfig(env)` 中显式传入该变量，彻底隔离磁盘与物理环境变量副作用。
- **扩展强类型配置契约与纯净化**：
  1. 在 `LlmConfig` 接口定义中扩展 `reasoningEffort?: string` 属性，在 `loader.ts` 的 `loadConfig()` 阶段完成对 `env.DEEPSEEK_REASONING_EFFORT` 环境变量的提取与 Fail-Fast 合法值校验（仅放行 `'high' | 'medium' | 'low' | 'disabled'` 并在异常时抛出错误）。
  2. 修改 `buildExtraPayload` 的函数签名，使其支持将配置中的 `reasoningEffort` 作为第二个可选参数传入：
     ```typescript
     buildExtraPayload?: (options?: Record<string, unknown>, reasoningEffort?: string) => Record<string, unknown>;
     ```
     这使得业务运行期逻辑仅从局部参数延迟获取配置，消灭静态字典中的 `process.env` 读取，使其退化为无副作用的纯函数。
- **ESLint 物理阻断网（物理阻断机制）**：
  在根目录 `eslint.config.js` 的 `rules` 中配置 `"no-process-env": "error"`。
  - **强制物理阻断**：所有业务代码及工具链若直接调用 `process.env`，将在静态扫描及 CI 门禁处直接报错拦截，物理阻断“魔术字段”的再次引入。
  - **受控例外**：仅在 `src/config/loader.ts`、`test/config/loader.test.ts` 以及系统初始化脚本等极少数基础物理 IO 交互层，通过 `/* eslint-disable no-process-env */` 注释允许访问全局 `process.env`。

## 5. 否决方案
- **方案 A (配置持有器单例 - Config Holder)**：
  该方案为了局部降低重构侵入性，在全局引入了单例存储状态。在多 Agent 实例并发运行场景下，全局单例会引起致命的配置覆盖和状态错乱，且由于存在全局共享状态，在 Vitest 等并发测试框架下会发生由于竞态条件导致的偶发性测试失败。故予以否决。
- **直接通过 `loader.ts` 导出全局 `const config = loadConfig()`**：
  会导致严重的物理循环依赖，且在 Node.js ESM 模块系统下会导致顶层变量为 `undefined` 的诡异运行时崩溃，故予以否决。
