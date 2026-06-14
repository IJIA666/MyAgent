# 探索主题: 核心架构解耦与上帝类重构 (Architectural Refactoring)

## 1. 问题定义
在当前的工程架构中，随着功能的不断叠加，部分核心文件出现了严重的“上帝类（God Object）”倾向。尤其是作为整个大脑枢纽的 `src/brain/session.ts`（长达 742 行），将 ReAct 推理循环、上下文压缩、工具大块输出脱敏、运行时规则加载等大量无关职责全部混杂在一起。这不仅严重违反了单一职责原则（SRP），也导致后续引入新特性（如长存活 PTY 终端或 AST 语义树导航）时会使代码变得难以测试和维护。其他如 `src/action/tools.ts` 也面临所有的底层原生工具堆砌在一个文件中的困境。

## 2. 关键发现与调研结果
- **代码库现状 (基于对 `session.ts` 的结构梳理)**：
  1. **状态与存储越权**：它深度绑定了 `loadState`、`saveState` 和 `rollback`，实际上这些应该归属于专门的 `SessionRepository` 或与 `SessionContext` 内聚。
  2. **上下文生命周期混入**：`compact`、`triggerAsyncCompactionIfNeeded` 以及追踪最近文件的 `collectReadToolFilePaths`，这些纯粹的“防爆仓”逻辑本应封装为独立的 `CompactionService` 或挂载为 `afterTurn` 中间件。
  3. **工具输出清洗**：`handleLargeToolOutput` 用来做巨量日志的削峰截断，这属于“工具执行层”的中间件行为，不该在 Session 的推演循环中硬编码。
  4. **JIT 动态上下文与全局规则**：`resolveJitContext` 与 `loadRulesToCache` 将规则的读取与拼接也放在了此文件中，其实应交给 `ContextAdapter` 体系或 `ConfigManager`。
- **文件目录分析 (`src/action/tools.ts`)**：
  拥有将近 500 行代码，所有的文件操作、搜索等 Native Tools 全部硬编码在此。未来扩容必将导致冲突。

## 3. 方案对比与推荐方向
为解决此问题，目前业界主流的 Agent 开源项目（如 Aider / OpenHands 等）普遍采用解耦策略，我们考虑以下两种架构演进方向：

| 评估维度 | 方案 A: 领域驱动服务化拆分 (Domain Services) | 方案 B: 中间件/生命周期事件驱动架构 (Middleware / Event-driven) | 选型分析 |
| :--- | :--- | :--- | :--- |
| **重构难度** | 较低。将功能抽取为独立的 Class（如 `CompactionService`），`SessionManager` 通过依赖注入调用。 | 较高。需建立一套类似 Koa 的洋葱模型，所有拦截和压缩通过注册 `preTurn` / `postTurn` 钩子完成。 | A 易于起步，改造成本可控 |
| **解耦程度** | 中等。核心主干仍需要知道这些 Service 的存在。 | 极高。ReAct 循环引擎对外暴露完全黑盒，插件插拔零耦合。 | B 占优 |
| **代码追踪难度** | 直观、线性，容易断点和追踪逻辑。 | 复杂，事件满天飞，如果单测覆盖不够容易引发隐秘的死锁或竞态。 | A 占优 |
| **扩展性** | 好，每个类各司其职，可以单独写 Mock 测试。 | 极佳，未来如要新增“成本超额告警”功能，加个钩子即可。 | B 占优 |

**推荐路径：以 A 为主干，结合局部的 B（混合架构）**
1. **纯粹的 ReAct 引擎**：`SessionManager` 退化为纯粹的 `AgentExecutionLoop`（即只管发请求给大模型并等待指令返回，解析指令后交由工具层）。
2. **剥离四大领域服务（Domain Services）**：
   - `CompactionService`：承接所有异步摘要、物理截断及文件指针逻辑。
   - `ContextRepository`：承接 `saveState`、`loadState` 等持久化读写。
   - `ToolExecutionDispatcher`：承接工具调用的路由，以及 `handleLargeToolOutput` 这种文本削峰截断过滤（类似于拦截器）。
   - `RuleAndPromptManager`：承接 JIT 组装与系统规则载入。
3. **原生工具分而治之**：将 `tools.ts` 炸开为 `src/action/native-tools/` 目录，每个能力（如 `FileSystemTools.ts`, `SearchTools.ts`）完全独立。

## 4. 约束、风险与未知项
- **爆炸半径极大**：重构直接涉及 `brain` 核心的脉络，任何重构带来的疏漏（比如遗失了之前好不容易写好的文件包裹、令牌计算逻辑）都会直接让智能体出现失忆或死循环。
- **单测依赖重建**：我们目前在 `test/brain` 下的 17 个测试用例是直接 Mock `SessionManager` 的关联逻辑，重构后几乎所有的测试套件都需要跟着大幅重构与分化。

## 5. 否决方案
- **引入完整的微内核插件系统 (Microkernel Architecture)**：像某些巨型框架那样通过 `Agent.registerPlugin()` 来管理所有核心能力。被舍弃的原因是：我们目前是一个单体 CLI，过度设计会导致项目陡增 2000 行基础建设代码，投入产出比极低，不符合敏捷实用的原则。
