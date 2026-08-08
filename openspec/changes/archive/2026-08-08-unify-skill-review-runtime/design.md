# 统一 Skill Review 运行时路径 —— 技术设计

## 背景

`BackgroundSkillReviewService`（`src/core/usecases/brain/background-skill-review.ts`）承担两类隔离 Skill Agent 任务：

- **Review**：主会话达到学习阈值后，把对话快照回放给隔离 Agent 复盘并维护 Skill；
- **Curator**：后台定期整合 Skill（经 `IsolatedSkillTaskRunner` 接口消费，`skill-curator.ts` 持引用）。

`runIsolatedSkillTask` 自引入通用子代理内核后存在双路径：注入 `subagentRuntime` 走 `SubagentRuntime.runTask`（生产路径），否则走手搓 AgentLoop 装配（fallback，仅供测试替身）。当前生产组合根（`session.ts`）与单元测试均已走通用路径，仅 2 处集成测试仍在手搓路径上，导致测试与生产行为分叉。

## 目标与非目标

**目标:**

- 删除 `runIsolatedSkillTask` 中的手搓装配分支，生产与全部测试统一走 `SubagentRuntime.runTask`。
- `subagentRuntime` 提升为必填构造依赖，类型层面杜绝未注入回退。
- 精简 `BackgroundSkillReviewServiceOptions`：删除仅手搓路径消费的 6 个字段（driver、llmConfigProvider、estimator、contextAdapter、appConfig、skillLibrary）。
- 集成测试（隔离语义、工具收窄、不落盘断言）在通用路径上继续成立。

**非目标:**

- 不修改 `SubagentRuntime` 本体及其 runTask 契约。
- 不修改 `BackgroundSkillAgent`（工具面收窄、读取账本、Curator 候选范围）。
- 不改变调度 FIFO、取消、关闭等待语义与 `BackgroundSkillReviewService` 对外接口签名。
- 不修改 `IsolatedSkillTaskRunner` 接口（skill-curator 消费方零改动）。
- 不改变任何生产行为——本 change 只删除生产不可达的代码路径。

## 架构决策

### 决策 1：删除手搓装配，`subagentRuntime` 必填，装配期明确抛错

**方案**：删除 `background-skill-review.ts` 中 `if (this.options.subagentRuntime)` 分支之外的整段手工装配（SessionContext/RuleManager/ContextRepository/ToolDispatcher/CompactionService/ContextBudgetCoordinator/PluginRegistry/AgentTracer/AgentLoop），把 `subagentRuntime` 从可选改为必填；同步清理不再使用的 imports 与 options 字段。

**"必填"的两种保证层级**：
1. **直接构造 `BackgroundSkillReviewService` 处**（单测 `background-skill-review.test.ts`、集成 `background-skill-isolation.test.ts` 150/276 行）：由 TypeScript 类型系统保证编译期必填，缺参直接编译失败。
2. **`SessionManager` 自动装配处**（`session.ts`）：`subagentRuntime` 字段本身是 `SubagentRuntime | undefined`（仅在 `subagentExecutionController` 与 `subagentLlmClientFactory` 齐备时创建），无法依赖类型系统收窄。装配策略为：当需要创建 Review 服务（`!backgroundSkillReviewScheduler && skillLibrary`）而 `subagentRuntime` 缺失时**明确抛出装配错误**，而不是静默禁用或使用非空断言（`!`）掩盖。**检查位置必须在 `subagentRuntime` 赋值之后、`RuleManager` 创建之前**——`RuleManager` 构造会向 `SkillLibrary.subscribe()` 注册监听（`RuleManager.ts:153-154`），若抛错晚于订阅，构造失败的 `SessionManager` 无法 `close()` 退订，监听引用会永久遗留；前置抛错保证 fail-fast 且零资源泄漏。服务构造点（403 行后）的再次检查仅为类型收窄（前置已保证非空），不构成回退分支。生产组合根（`index.ts`）恒创建子代理依赖，抛错分支生产不可达；该错误只会在装配错误或测试遗漏依赖时暴露——这正是 fail-fast 的目的。

**理由（Why X over Y?）**：
- 双路径意味着任何行为修复要在两处同步落地，且集成测试测的是生产不走的路径，测试保真度低。这是比"死代码"更实质的风险。
- 保留 fallback 并不可取：通用内核（`SubagentRuntime.runTask`）已在生产运行并覆盖同一套骨架（RuleManager、ContextRepository、AgentLoop、transcript），无场景需要第二条装配。
- 必填依赖让"未注入"在编译期失败（直接构造处）或装配期失败（SessionManager 处），而不是运行时静默回退到旧路径——fail-fast 优于 fail-soft。

**替代方案**：仅修改集成测试注入 `subagentRuntime`、保留手搓路径作为 fallback。**否决理由**：死路径持续产生维护与覆盖成本，且没有真实调用者，保留只会继续误导测试保真度。

### 决策 2：测试装配点迁移——注入运行器或外部 scheduler 分流

**方案**：按"是否实际调用复盘"分两类迁移：
- **注入运行器**（实际调用 `runReview` 的测试）：`background-skill-isolation.test.ts` 150/276 行、`SessionManager.test.ts` 1287/1453 行。用 `DelegatingLlmClientFactory` 包装现有 mock driver，构造 `SubagentRuntime` 注入 service。`background-skill-isolation.test.ts` **文件内已有该工厂**（648 行定义，405/587 行已使用），直接复用不新增；`SessionManager.test.ts` 无此设施，需新增一份（与单测/集成文件同构）。现有断言（父会话历史不变、只暴露三个 Skill 工具、sessionsDir 无落盘、通知基于真实结果）原样保留。
- **外部 scheduler 避免创建服务**（不调用复盘、仅经 SessionManager 构造的测试）：`SessionManager.test.ts` 1164 行、`background-skill-isolation.test.ts` 471 行 freshSession。改为传入 mock scheduler（`backgroundSkillReviewScheduler`），使 `!scheduler && skillLibrary` 条件不成立、服务不创建，避免引入无运行器装配。

**理由**：单测已验证该模式（包装旧 Fake 为新客户端对象、验证实例隔离与不落盘契约），复用可避免重新发明测试基建；断言语义是隔离契约而非执行器实现细节，清理后仍必须成立。不调用复盘的构造点用 scheduler 分流，改动面最小且不改变被测行为。

### 决策 3：options 精简范围

**方案**：删除 `BackgroundSkillReviewServiceOptions` 中仅手搓路径消费的字段：`driver`、`llmConfigProvider`、`estimator`、`contextAdapter`、`appConfig`、`skillLibrary`。保留：`toolRegistry`、`parentPermissionStateProvider`、`parentCallerProvider`、`subagentRuntime`（必填）、`notify`（可选）。`skillLibrary` 虽在 `session.ts` 构造点仍被用到，但它是 SessionManager 自己持有、不传给 service——service 侧该字段删除。

**理由**：手搓路径消费这些依赖用于装配 ContextBudgetCoordinator、RuleManager、ToolDispatcher 等；通用路径由 `SubagentRuntime` 内部自行装配，service 不再需要这些端口。删减后 service 依赖面缩小、构造点（session.ts 与各测试装配点）同步简化。

## 风险与权衡

- [集成测试与 SessionManager 测试改造后断言可能因通用路径行为差异失败] -> 先跑单测确认通用路径已覆盖同类断言；集成测试断言聚焦隔离语义（历史不污染、工具收窄、不落盘），属于既有规格，与执行器无关，预期稳定。**若失败，先判断公共运行器是否违反既有隔离规格（此时应修复运行路径，不得改断言）；只有确认为纯实现细节断言（如事件计数等非规格行为）才允许修正，并须在 change 内记录判定依据。** 禁止以实现行为反向放宽隔离规格断言。
- [SessionManager 测试注入运行器后 mock driver 被包装，调用观测变化] -> `DelegatingLlmClientFactory` 已提供调用透传（单测验证），断言聚焦事件与隔离语义，不依赖 driver 原始引用。
- [删除后无法再验证手搓路径] -> 手搓路径生产不可达且无保留价值，删除即目标；`SubagentRuntime` 自身路径仍有单测与集成测试覆盖。
