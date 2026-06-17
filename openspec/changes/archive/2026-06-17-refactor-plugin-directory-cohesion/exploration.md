# 探索主题: 目录结构优化

## 1. 问题定义
目前智能体生命周期插件的各个基础设施文件（ 包含类型定义 `plugin-types.ts`、注册中心 `plugin-registry.ts` 和运行器 `plugin-runner.ts` ）零散平铺在 `src/brain/` 根目录中，而具体的插件实现又存放在 `src/brain/plugins/` 子文件夹里。这使得 `src/brain/` 根部显得较为杂乱。我们需要调研业界（ 特别是 `Claude Code` 参考项目 ）在插件与模块划分上的优秀实践，并设计出一套保障系统高内聚、易维护的目录优化方案。

## 2. 关键发现与调研结果
- **代码库现状**：`src/brain/` 根部目前平铺了多达 12 个文件，其中 3 个与插件系统基础定义相关，4 个业务插件存放在 `src/brain/plugins/` 下，整体划分尚未实现包级自治。
- **核实与洞察**：在对 `Agents` 目录下全部 7 个开源参考项目（ 包含 `Claude Code` 、 `opencode` 、 `hermes-agent` 、 `openclaw` 、 `codex` 、 `gemini-cli` 与 `tinypace-ai-desktop` ）的源码物理结构进行深度分析与跨项目大调研后，我们发现：
  1.  **Claude Code 的架构自治与解耦**：其核心类型声明（ 如 `Plugin` 等 ）被统一提炼到独立的 `src/types/plugin.ts` 中以防循环导入；而其内置插件管理（ `builtinPlugins.ts` ）与预置技能打包完全收拢在 `src/plugins/` 目录中。外部大循环（ `QueryEngine.ts` ）只专注于骨架调度，对插件具体逻辑完全解耦。
  2.  **opencode 的 Monorepo 级高度隔离**：作为一个大型应用，其在项目根部将插件系统直接隔离为独立的子包 `packages/plugin/`（ 剥离了环境依赖与特定宿主代码 ）；同时在核心包的 `packages/core/src/plugin.ts` 定义插件契约，而将各个具体维度的插件管理与对接逻辑（ 智能体 `agent.ts`、命令行 `command.ts` 等 ）完全聚拢在 `packages/core/src/plugin/` 独立子目录下，实现模块的高度自治。
  3.  **hermes-agent 的 Provider-Registry 模式**：作为一个复杂的 Python 智能体系统，其在核心编排层（ `agent/` ）仅通过定义通用的 `*_provider.py`（ 规范化契约接口 ）与 `*_registry.py`（ 服务注册中心 ）进行调度；而将各个特化的外部功能插件（ 如 `spotify`、`observability` 等 ）完全隔离在核心外部的独立自闭环 `plugins/` 目录下，并使用 `plugin_utils.py` 进行插件生命周期扫描与加载，实现了极佳的水平扩展性。
  4.  **openclaw 的 SDK 契约与 Extensions 顶层分立**：在 Monorepo 体系下，其核心库仅用于声明基础逻辑，将插件相关的定义提升为顶层的 `packages/plugin-sdk/` 和 `packages/plugin-package-contract/`；而将数量多达 130 多个的各大模型厂商适配、外部工具及特定拦截切面，全部放置在顶级独立的 `extensions/`（ 扩展 ）目录中，使底层内核不受任何特定第三方供应商或业务切面的污染，保持了高度的纯粹与敏捷度。
  5.  **codex 的 Rust Workspace 多 Crate 物理切割**：该系统在 Rust 架构下，专门将插件的基础契约、SDK 和核心宏与声明剥离为独立的 `plugin/` crate；将打包内置的业务功能插件收归于 `core-plugins/` 独立 crate；从而保证了主核心 `core/` 仅作为一个纯粹的 Agent Graph 图调度器存在，绝不承担多余的内置业务细节。
  6.  **gemini-cli 的 SDK 契约包抽取**：同样在 pnpm 多包工作区下，将生命周期 Hook 等外部开发契约与定义提取为 `packages/sdk/`；核心引擎则置于 `packages/core/`，与终端 CLI 宿主完成完全的物理解耦。
  7.  **tinypace-ai-desktop 的前后端渲染分立**：采用 Electron 体系，将智能体业务核心服务（ Services ）与 UI 渲染交互进程在目录上分门别类独立打包，隔离各子领域依赖。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 1 ( 维持现状 ) | 方案 2 ( 高内聚微调收拢 ) | 方案 3 ( 领域模型重构 ) | 结论 |
| :--- | :--- | :--- | :--- | :--- |
| **重构成本与风险** | 零成本 ✓ | 极低（ 仅修改少部分内部引用 ）✓ | 极高（ 需大面积移动文件，破坏性较强 ）✗ | 方案 1 / 2 占优 |
| **目录结构清爽度** | 略显杂乱（ 12 个文件平铺 ）✗ | 极佳（ 根部收纳，仅剩 3 - 4 个主骨架 ）✓ | 极佳（ 按大领域垂直划分 ）✓ | 方案 2 / 3 占优 |
| **插件系统自治性** | 偏弱（ 核心逻辑散落在根部 ）✗ | 极高（ 接口/运行器/具体插件归于一处 ）✓ | 极高（ 作为运行内核的中间件层 ）✓ | 方案 2 / 3 占优 |

**推荐路径**：选择 **方案 2 ( 高内聚微调收拢 )** 核心方向。
- **具体做法**：
  1.  将 `src/brain/plugin-runner.ts`、`src/brain/plugin-types.ts` 与 `src/brain/plugin-registry.ts` 移动到 `src/brain/plugins/` 下。
  2.  在 `src/brain/plugins/index.ts` 中统一对它们及各具体插件进行 Barrel 导出。
  3.  让 `src/brain/agent-loop.ts` 等内核代码仅从 `src/brain/plugins` 这一层级导入所需接口，实现大循环和具体插件管理的完全隔离。

## 4. 约束、风险与未知项
- **级联导入修改**：目录移动后，项目内所有涉及插件类型的 `import` 路径（ 包含生产代码和 `plugins.test.ts` 测试文件 ）必须同步级联修改。
- **构建与测试稳定性**：必须确保重构后 `npm run build` 与 `npm run test` 依然全绿通过，防止引入逻辑回归。
- **技术风险：Barrel 导出的循环依赖（ Circular Dependencies ）隐患**：
  在落地方案 2 的 `index.ts` 导出时，极易因目录内部文件交叉引用导致运行时 `undefined` 崩溃。必须严格贯彻以下双防线：
  1.  **对内防线（ Internal ）**：所有在 `src/brain/plugins/` 目录内部的文件（ 如 `plugin-runner.ts` 、 `TokenWatermarkPlugin.ts` 等 ），严禁从自身的 `index.ts` 导入任何属性，必须全部使用具体的相对路径直连（ 例如 `import { HookContext } from './plugin-types.js'` ）。
  2.  **对外防线（ External ）**： `index.ts` 仅作为一个 **“单向出口”** 暴露给外层的 `src/brain/agent-loop.ts` 或单元测试引用，严禁任何逆向回导。

## 5. 否决方案
- **全面领域驱动重构 ( 方案 3 )**：虽然架构表现最理想，但在目前 MyAgent 的中等体量下属于“过度工程”，且全量文件移动会引入过大的单元测试重构风险。
