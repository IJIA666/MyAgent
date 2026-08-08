# 统一 Skill Review 运行时路径

## 改造原因

`BackgroundSkillReviewService.runIsolatedSkillTask` 保留了两条执行路径：

1. **通用路径**（生产已切换）：注入 `subagentRuntime` 时走 `SubagentRuntime.runTask`，复用通用子代理隔离骨架（权限派生、上下文创建、RuleManager/ContextRepository/AgentLoop 装配、transcript 管理）。
2. **手搓装配路径**（`background-skill-review.ts` 遗留 fallback）：未注入 `subagentRuntime` 时手工装配 SessionContext、RuleManager、ContextRepository、ToolDispatcher、CompactionService、ContextBudgetCoordinator、PluginRegistry、AgentTracer 与 AgentLoop，约 100 行。

现状核实：

- 生产组合根（`session.ts`）已注入 `subagentRuntime`，且组合根无条件创建其依赖（`index.ts`），生产路径永远走通用路径；
- 单元测试已切换通用路径（`DelegatingLlmClientFactory` 模式）；
- **仅集成测试（`background-skill-isolation.test.ts` 两处构造）仍走手搓装配**。

由此产生实质风险：集成测试测的是一条生产永远不走的路，测试与生产存在行为分叉（如 system 覆写、记忆注入、预算控制、transcript 语义差异），测试可能给出虚假绿灯。手搓路径同时迫使 service 保留 6 个仅它消费的构造依赖（driver、llmConfigProvider、estimator、contextAdapter、appConfig、skillLibrary），维护成本高。

现在做：通用内核（`SubagentRuntime.runTask`）已稳定运行，单测已验证注入模式可行，是删除死路径、收敛双路径的正确时机。

## 变更内容

- **删除** `background-skill-review.ts` 中手搓 AgentLoop 装配分支及其专用 imports（AgentLoop、ToolDispatcher、CompactionService、ContextBudgetCoordinator、ContextBudgetPlanner、ContextHistoryPruner、ContextRepository、RuleManager、AgentTracer、PluginRegistry、SessionContext、createEmptyMemorySnapshot 等）。
- **修改** `BackgroundSkillReviewServiceOptions`（导出的内部装配契约）：`subagentRuntime` 由可选改为**必填**；删除仅手搓路径消费的字段（driver、llmConfigProvider、estimator、contextAdapter、appConfig、skillLibrary）。**运行行为不变，但该接口发生有意的源码级构造契约变更（编译期必填）**。
- **修改** `session.ts` 装配点：按精简后的 options 传参；因 `subagentRuntime` 仅在子代理依赖齐备时存在，装配缺少运行器时明确抛错（fail-fast，不使用非空断言、不静默禁用）。
- **修改** 测试：
  - `test/integration/background-skill-isolation.test.ts` 两处直接构造（150、276 行）注入真实 `SubagentRuntime`（**复用文件内已有的 `DelegatingLlmClientFactory`**，不新增副本）；`freshSession` 构造（471 行）因不调用复盘，改用外部 scheduler 避免创建 Review 服务；
  - `test/core/usecases/brain/background-skill-review.test.ts` 的 `createService` 同步精简传参（已注入运行器，仅移除已删字段）；
  - `test/core/usecases/engine/SessionManager.test.ts` 三处构造（1164、1287、1453 行）迁移：1287/1453 实际调用 `runReview`，需注入 `SubagentRuntime`（新增 `DelegatingLlmClientFactory` 包装现有 mock driver）；1164 不调用复盘，改用外部 scheduler 避免创建服务。

**对外契约**：`BackgroundSkillReviewService` 的 schedule/runReview/runIsolatedSkillTask/close 签名与语义不变；`IsolatedSkillTaskRunner` 接口不变（skill-curator 消费方不受影响）；`BackgroundSkillAgent` 工具收窄、读取账本、Curator 候选范围不变；调度 FIFO、取消、关闭等待语义不变。**生产运行行为不变**（生产组合根恒注入运行器，抛错分支生产不可达）。

## 业务能力

### 新增业务能力

（无）

### 修改业务能力

- `background-skill-learning`: ADDED —— 新增"后台 Skill Agent 统一经公共子代理运行器执行"需求：Review 与 Curator 必须经 `SubagentRuntime.runTask` 执行，`subagentRuntime` 为必填依赖，禁止第二套独立装配路径（该约束此前未写入规格，本次清理将其确立为契约）。`skill-curation` 的既有需求不变化；`SubagentRuntime.runTask` 内部仍使用 AgentLoop 执行循环，spec 中"隔离 AgentLoop"表述清理后依然成立。

## 影响范围

- `src/core/usecases/brain/background-skill-review.ts`：删除手搓装配分支，options 精简，subagentRuntime 必填。
- `src/core/usecases/engine/session.ts`：装配点传参精简 + 缺少运行器时明确抛错。
- 测试（完整调用点清单，含经 SessionManager 间接构造者）：
  - `test/integration/background-skill-isolation.test.ts`：150、276 行注入运行器（文件内已有 `DelegatingLlmClientFactory`，405/587 行已注入的不变）；471 行 freshSession 改传外部 scheduler；
  - `test/core/usecases/brain/background-skill-review.test.ts`：`createService` 移除已删 6 字段（运行器已注入）；
  - `test/core/usecases/engine/SessionManager.test.ts`：1287、1453 行注入运行器（新增 `DelegatingLlmClientFactory`）；1164 行改传外部 scheduler；其余 21 处构造点经核实不受影响（未传 skillLibrary 或已传 scheduler/子代理依赖）；
  - `test/integration/skill-learning-loop.test.ts`（340 行）、`subagent-execution.test.ts`（581 行）、`loopback.test.ts`（231/343 行）：经核实已注入子代理依赖或不创建 Review 服务，无需改动。
- 契约影响：`BackgroundSkillReviewServiceOptions` 为导出接口，发生构造契约变更（6 字段删除 + subagentRuntime 必填）；`background-skill-learning` 规格新增"统一运行器 + 装配期抛错"需求；`SubagentRuntime` 依赖成为 service 必填依赖，所有装配点（组合根与测试）需同步提供。
