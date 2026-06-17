## 背景

当前智能体的 Hook 生命周期插件系统的相关基础设施和平铺文件零散放置在 `src/brain/` 根部目录下。这不仅使得核心编排层的目录显得庞杂，也违背了我们在竞品（ 如 `Claude Code` 与 `opencode` ）中所看到的“插件包包级高内聚、高自治”设计原则。为了净化核心大循环的物理目录，需要将其彻底归拢收纳到 `src/brain/plugins/` 下并利用 Barrel 导出统一对外暴露。

## 目标与非目标

**目标:**
- **物理目录净化**：将 `plugin-types.ts` 、 `plugin-registry.ts` 和 `plugin-runner.ts` 统一移入 `src/brain/plugins/` 目录中。
- **高内聚自治化**：在 `src/brain/plugins/index.ts` 进行统一的单向对外导出。
- **循环依赖防范**：通过严格的直连规则防线，杜绝重构中可能引入的 Barrel 导入循环依赖（ Circular Dependencies ）。
- **兼容与稳定**：保证级联修改后编译与全部 38 个单元测试用例全绿通过，外部调用 API 完全保持兼容。

**非目标:**
- **不重构业务逻辑**：不改变任何现有的插件（ 如 `TokenWatermarkPlugin` 、 `JitRulesPlugin` 等 ）的内部拦截执行逻辑。
- **不增加新 Hook 事件**：本次不新增或修改任何智能体大循环的 Hook 触发点。

## 架构决策

### 决策一：单向 Barrel 出口模式（ One-Way Barrel Export ）
- **具体做法**：
  在 `src/brain/plugins/index.ts` 中统一将插件系统的强类型定义（ `HookEventName` 、 `HookContext` 、 `Plugin` ）、中间件运行器（ `pluginRunner` ）与注册管理器（ `PluginRegistry` ）以及四个具体业务插件类进行单向对外导出。
- **理由**：
  这为大循环（ `agent-loop.ts` ）、会话管理器（ `session.ts` ）及外层单元测试提供了极简的一站式接口引用路径。大循环无需感知插件内部细碎的子文件。

### 决策二：防范循环依赖的对内直连规则（ Internal Relative Path Import ）
- **具体做法**：
  - **对内防线**：所有存放于 `src/brain/plugins/` 内部的基础类和具体插件实现（ 如 `plugin-runner.ts` 、 `TokenWatermarkPlugin.ts` 等 ），在互相引用对方导出的类或接口时，**严禁**通过自身包的 `./index.js` 导入，必须使用相对路径直连（ 如 `import { HookContext } from './plugin-types.js'` ）。
  - **对外防线**： `index.ts` 只向外单向输出，绝对不允许内部任何文件逆向引用它。
- **理由**：
  由于 `index.ts` 既输出了接口类型又输出了具体的插件类，若子模块反向从其导入，将会在编译或打包后因模块的未完成加载（ Temporary Dead Zone ）导致某些类或枚举在运行时解析为 `undefined` 崩溃。通过物理切断内部文件对 `index.ts` 的反向引用，能从源头上杜绝这一极具隐蔽性的技术陷阱。

### 决策三：替代方案评估（ Why 方案 2 over 方案 3? ）
- **曾经考虑的替代方案（ 方案 3 ）**：将整个项目按领域模型划分，拆分为 `memory/` 、 `tools/` 与 `orchestrator/` 独立目录。
- **舍弃理由**：由于 MyAgent 现阶段项目体量处于中等规模，直接大面积调整整个项目的物理文件结构代价过大，且伴随着大范围重构的非预期回归风险。采用高内聚微调收拢的方案 2 既能快速完成目录梳理，又将改动范围收敛在插件系统这一条线内，具备最高的性价比与安全性。

## 风险与权衡

- **[ 风险点一 ]**：重构大面积级联修改 `import` 导致拼写错误或类型引用丢失。
  - **缓解策略**：在物理移动文件后，由 IDE 或静态代码分析工具进行全量级联更新；并在重构后立即运行 `npm run build` 和 `npm run lint` 保证 TypeScript 强类型编译无损。
- **[ 风险点二 ]**：打包工具或运行时可能存在隐蔽的循环引用链。
  - **缓解策略**：严格贯彻执行“双防线规则”，并在本地利用 `vitest` 跑通全部单元测试以捕获任何运行时的 `undefined` 隐患。
