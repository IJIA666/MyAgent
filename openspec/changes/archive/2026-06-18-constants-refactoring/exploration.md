# 探索主题: 全局魔法字段与配置体系优化

## 1. 问题定义
在当前系统中，存在两类主要的“魔法字段”问题：
1. **环境变量魔术读取**：例如 `DEEPSEEK_MODEL`、`AGENT_WORK_MODE`、`DEEPSEEK_REASONING_EFFORT` 等在非初始化模块（如 `models.ts`、`terminal-config.ts`）中散乱地直接读取 `process.env`，缺乏统一的验证机制，也无法在编译期进行类型约束。
2. **工具名称与常量割裂**：本地内置工具名（如 `grepSearch`、`globSearch`、`load_skill`）以及拦截插件 `HumanApprovalPlugin` 里的工具别名数组存在多处行内硬编码，没有集中收拢，极易由于拼写错误导致安全卡关失效。

## 2. 关键发现与调研结果
- **代码库现状**：
  - `src/config/models.ts` 中存在多处直接读取 `process.env.DEEPSEEK_REASONING_EFFORT` 的硬编码。
  - `src/action/native-tools/terminal-config.ts` 在 `loadWorkMode` 中直接从 `process.env.AGENT_WORK_MODE` 加载工作模式。
  - `src/config/loader.ts` 在加载时直接处理 `process.env.DEEPSEEK_MODEL` 和 `process.env.AUTHORIZED_WORKSPACE_DIR`，但未能将其余环境变量（如推理等级、工作模式）统一合并与校验。
  - `src/brain/plugins/HumanApprovalPlugin.ts` 定义了多个局部别名数组，其中夹杂硬编码字符串，如 `'bash'`、`'sh'`、`'executeCommandTool'` 等。
- **核实与洞察**：
  - 通过网络检索 TypeScript 配置管理最佳实践，得出行业标准是：**收拢并校验环境变量**。不再让业务代码直接访问 `process.env`，而是在应用启动时，通过统一的配置加载器校验所有的环境变量，构建深度冻结（Frozen）的强类型全局 `AppConfig` 单例，供全模块使用。
  - 对于常数字符串，应当采用 `as const` 或统一的只读类（Readonly Class / Enum）并在同一个常量模块（如 `src/common/constants.ts`）集中维护，由 TypeScript 保证编译时的类型安全性。

## 3. 方案对比与推荐方向
| 评估维度 | 方案一：集中收拢环境变量与全局配置体系 | 方案二：重构工具名称与常量契约体系 | 结论 |
| :--- | :--- | :--- | :--- |
| **优化目标** | 彻底收拢所有的 `process.env` 获取，只在 `loader.ts` 初始化时一次性读取、验证并冻结进 `AppConfig`，各模块统一引用该全局配置。 | 将所有本地工具名、模式字面量以及插件别名提取为强类型的 `as const` 或 `enum`，在 `ToolConstants` 统一管理。 | 方案一解决**运行期配置安全**；方案二解决**开发期代码拼写安全**。 |
| **安全性保证** | **高 ✓**（防止敏感变量运行期被篡改或漏验证） | **中**（主要防止代码编写时的拼写错误） | 方案一在防范安全越界方面更佳。 |
| **改造复杂度** | **中**（需改造 `AppConfig` 契约并调整各模块的读取） | **低**（主要是提取常量并替换硬编码） | 方案二改造范围更为集中。 |
| **扩展性支持** | **强 ✓**（未来新增大模型或环境变量，只需在 `loader.ts` 和 `AppConfig` 中增加声明） | **强 ✓**（未来引入新工具或新安全策略时可实现集中配置） | 两者都对后续扩展有显著改善。 |

**推荐路径**：
基于控制系统爆炸半径与平滑演进的考量，本次变更**仅执行方案二**（常量契约体系重构）。我们将集中排查 `HumanApprovalPlugin` 及各工具层，把散落的工具别名硬编码统一收归至 `ToolConstants` 中集中管理，以极低的成本解决代码拼写带来的安全卡关漏洞。

至于**方案一**（全局配置体系收拢与 `process.env` 改造），由于牵扯到 `loader.ts` 与底层模块的耦合，且包含不可忽视的循环依赖风险，将其列为**历史遗留问题与远期演进规划**。这种“先治标后治本”的策略能保证 100% 的平滑过渡，因为两者在技术实现上互不干扰。

## 4. 约束、风险与未知项
- **无显著架构风险**：本次范围缩减后，仅执行常量提取（方案二），完全不触及环境配置与启动生命周期，因此之前的循环依赖与时序风险被彻底规避。
- **一致性校验回归**：唯一的风险点在于提取出的 `ToolConstants` 字符串值必须与原硬编码保持绝对一致（包括大小写别名），否则可能会导致 `HumanApprovalPlugin` 的白名单拦截判断失效。

## 5. 否决方案
- **全局 `declare global NodeJS.ProcessEnv` 扩充**：虽然这种方式可以在使用 `process.env` 时带来类型提示，但它无法解决硬编码字符串散落在各处的问题，也无法实现“Fail-Fast（启动时快速报错）”的校验逻辑。
