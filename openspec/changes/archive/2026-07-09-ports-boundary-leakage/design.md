## 背景

当前 `src/ports/` 目录虽在物理上构成了分层骨架，但其导出的接口存在三处核心类型泄漏，导致"端口层只表达契约"的原则被架空：

1. **驱动端口 `ChatUseCase`** 以 `approvalService: ApprovalService` 属性直接暴露了一个核心 **class**（`src/core/usecases/security/ApprovalService`）作为公开 API 的一部分，同时在 `on/off` 方法签名中引用了 `AgentEvent`（定义于 `src/core/usecases/engine/agent-loop.ts`）。
2. **驱动端口 `ToolAccessMetadataPort` 和 `AgentPlugin`** 分别从 `core/usecases/security/SafetyResource` 和 `core/usecases/plugins/plugin-types` 导入类型，使得端口层在实际上成为核心类型的"转运层"。
3. **输入适配器 `CliFacade`** 直接构造并持有 `SessionManager` 实例，而非仅依赖 `ChatUseCase` 契约，导致 UI 层能接触到过多核心实现细节。

## 目标与非目标

**目标:**
- 消除 `src/ports/` 下所有接口对 `src/core/` 具体实现类 / 内部类型的直接 import 依赖。
- 将 `CliFacade` 的构造依赖从 `SessionManager` 收口为 `ChatUseCase`。
- 所有泄漏的 core 类型在 ports 层建立对应的纯接口或纯数据结构等价定义。
- 保持全部现有行为不变（纯重构，零功能变更）。

**非目标:**
- 不改变 `core` 内部的职责边界或业务行为；允许为适配端口契约调整 import 来源、接口实现声明和少量装配代码。
- 不引入新的业务能力或修改现有业务行为。
- 不涉及 `adapters/output` 或其它非输入适配器的重构。
- 不改变测试结构（仅适配接口变更）。

## 架构决策

### ADR-1：端口层引入自有审批契约

**现状：** `ChatUseCase.approvalService` 类型为 `ApprovalService`（一个 core 中的 concrete class），端口消费者被迫依赖核心实现的全部签名（包括 `rejectAll`、`setBypassMode` 等端口不应关心的管理方法）。

**决策：** 在端口层引入自有审批契约，定义仅供驱动端口消费者需要的审批交互能力。

- `ChatUseCase.approvalService` 类型变更为端口层审批契约。
- `ApprovalService` (core) 适配该端口契约，保持其额外管理能力仍可在 core 内部使用。

**替换方案考虑：**
- **选项 A（否决）**：在 `ChatUseCase` 上定义审批方法而非属性。这会使接口膨胀，每个审批调用都需要使用者感知，打破了 `approvalService` 作为独立关注点的分离。
- **选项 B（采纳）**：提取最小接口。仅暴露输入适配器真正需要的审批交互能力，`rejectAll`、`setBypassMode` 等管理方法不再作为驱动端口的一部分暴露。

### ADR-2：`AgentEvent` 类型定义提升至 ports 层

**现状：** `AgentEvent` 联合类型定义在 `src/core/usecases/engine/agent-loop.ts`，被 `ChatUseCase.on/off` 方法引用。

**决策：** 将 `AgentEvent` 类型定义移至端口层拥有的位置，作为驱动端口共用的数据结构类型。

- `core/usecases/engine/agent-loop.ts` 改为从 `../../../ports/shared/agent-events.js` import。
- `AgentEvent` 本身是纯联合类型（无方法、无 class），迁移不会产生副作用。

### ADR-3：`SafetyResource` 提升至 ports 层

**现状：** `ToolAccessMetadataPort.ResourceExtractor` 返回值类型为 `SafetyResource`（定义于 `core/usecases/security/SafetyResource.ts`）。

**决策：** 将 `SafetyResource` 类型定义移至端口层拥有的位置。

- `SafetyResource` 是纯联合类型（`{kind, access, normalizedPath}` 等字面量结构），迁移至 ports 层完全合理。
- core 内部需要继续复用该类型时，改为从端口层共享位置导入或 re-export。

### ADR-4：插件 Hook 类型迁至 ports 层专用契约

**现状：** `AgentPlugin.hooks` 索引签名使用 `HookEventName`（enum）和 `HookMiddleware`（type），均定义于 `core/usecases/plugins/plugin-types.ts`。

**决策：** 在端口层拥有的位置定义 `AgentPlugin` 所需的插件契约类型，使其不再依赖 core 内部插件类型文件。

> **注意：** `HookEventName` 和 `HookMiddleware` 是纯类型 / 枚举，并不依赖 core 的具体实现。原始位置仅作为 implementation detail 留在了 core 目录下。本决策将其归位到端口层的共享契约区域。

### ADR-5：`CliFacade` 依赖从 `SessionManager` 收口为 `ChatUseCase`

**现状：** `CliFacade` 构造函数接受 `SessionManager` 实例，并直接访问 `SessionManager` 特有方法（`setInteractionPort`、`getContext`、`approvalService` 等）。

**决策：** 将构造函数参数类型从 `SessionManager` 替换为 `ChatUseCase`，并通过扩展驱动端口或补充配套契约，覆盖 `CliFacade` 实际需要的全部会话控制能力。

**影响：**
- `CliFacade` 当前依赖的 `workMode`、挂起交互恢复、审批 handler 注册等能力，需要通过驱动端口或配套契约重新表达。
- 这些能力最终落到 `ChatUseCase` 还是拆成辅助契约，是设计决策，不应写入需求规格。

## 风险与权衡

| 风险 | 影响 | 缓解策略 |
| :--- | :--- | :--- |
| 审批契约从 core 类抽离后，`CliFacade` 所需能力可能表达不足 | 需要补充配套抽象 | 先以 `CliFacade` 的真实使用面反推最小契约，再落具体接口名 |
| 共享类型承载位置选择不当 | 共享契约再次碎片化 | 统一在端口层拥有的位置收纳纯类型，并按关注点分文件 |
| `ChatUseCase` 扩口过多 | 驱动端口变成“大而全”门面 | 以输入适配器真实最小使用面约束接口增长 |
| step 1 和 step 2 的中间状态可能导致编译中断 | 中间不可用 | 每个 step 应在分支上完成再合并，中间不发布 |

## 迁移计划

### Step 1：端口契约收口

1. 为审批、事件、安全资源与插件 hook 类型选定端口层拥有的位置。
2. 调整 `ChatUseCase`、`ToolAccessMetadataPort`、`AgentPlugin` 的类型依赖来源。
3. 让 core 内部改为导入或复用端口层拥有的共享类型，而不再反向让 ports 依赖 core。
4. 让 `ApprovalService` 适配新的端口层审批契约。

### Step 2：输入适配器依赖收敛

1. 根据 `CliFacade` 的真实使用面，补齐驱动端口缺失的最小能力。
2. 让 `SessionManager` 适配这些新增的驱动端口能力。
3. 修改 `CliFacade` 构造函数参数类型为 `ChatUseCase`。
4. 调整 `CliFacade` 内部访问模式，移除对 `SessionManager` 特有属性的直接引用。

### 回滚策略

若任一 Step 导致线上故障，直接 revert 对应 Step 的 commit。Step 1 与 Step 2 互不依赖，可独立回滚。

## 开放问题

- `PendingInteraction` 是否属于纯共享数据结构，还是继续保留在 core 领域对象中，更适合作为下一轮边界判断而不是本次 requirement 的一部分。
- 插件 hook 相关类型在迁移到端口层拥有的位置后，是否会引入新的运行时 import 环，需要在实现时逐个检查。
