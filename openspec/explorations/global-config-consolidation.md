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
  - **循环依赖关系**：`loader.ts` 导入了 `models.ts` 和 `terminal-config.ts` 进行配置组装。若后两者反向从 `loader.ts` 导入配置，将形成 `loader -> terminal-config -> loader` 的物理循环依赖（Circular Dependency）。
- **核实与洞察**：
  - **规避方案调研**：在 TypeScript ESM 环境下，规避循环依赖通常有两种途径：
    1. **轻量配置持有器（Config Holder）**：定义一个不含任何业务依赖的极简单例模块专门持有已初始化的 `AppConfig`，供各模块读取。
    2. **显式依赖注入（Dependency Injection）**：重构业务函数或类，使它们不再依赖全局状态，配置仅通过参数显式注入。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 A (配置持有器单例 - Config Holder) | 方案 B (纯依赖注入 - Dependency Injection) | 结论 |
| :--- | :--- | :--- | :--- |
| **循环依赖风险** | **极低 ✓**（业务模块仅依赖极简的 holder，不依赖 loader 逻辑） | **零 ✓**（完全解耦，无全局变量引用） | 方案 B 占优 |
| **业务改造侵入性** | **极低 ✓**（仅需将各处的 `process.env.XXX` 替换为 `getConfig().XXX`） | **高 ✗**（需要逐级修改函数签名和类构造器，重构范围大） | 方案 A 占优 |
| **测试便利性** | **中**（需要提供 `setConfig()` 接口以便在单测中 mock） | **极高 ✓**（单测中可直接传入不同的 Mock 配置对象） | 方案 B 占优 |
| **代码维护心智** | **高 ✓**（使用直观，心智负担低） | **极高 ✓**（无全局状态，符合函数式纯净性） | 方案 B 占优 |

**推荐路径**：
基于控制系统重构爆炸半径与心智成本的平衡，**推荐采用 方案 A (配置持有器单例)**。
通过新建一个无依赖的 `holder.ts`，既打破了 `loader.ts` 与业务层 `terminal-config.ts`/`models.ts` 的双向循环依赖，又允许业务层以极小的代价实现快速收拢，非常适合渐进式重构。

## 4. 约束、风险与未知项
- **未初始化读取防护**：如果某模块在 `loadConfig()` 完成前，在模块顶层作用域（Module Scope）中调用了 `getConfig()`，将由于配置尚未写入而获取到未定义值。
  - *防御策略*：强制规定所有业务逻辑必须在运行时函数内部延迟获取配置，严禁在模块级顶层初始化中执行 `getConfig()`。
- **安全拦截防污染**：单元测试环境启动时，必须确保可以重载或清除 Holder 中的状态，防止测试用例之间互相污染。

## 5. 否决方案
- **直接通过 `loader.ts` 导出全局 `const config = loadConfig()`**：
  这种方案将直接导致 `models.ts` 和 `terminal-config.ts` 循环导入 `loader.ts`，在 Node.js ESM 模块系统下会导致顶层变量为 `undefined` 的诡异运行时崩溃，故予以否决。
