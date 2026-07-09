## 改造原因

当前代码仓库已经采用 `core / ports / adapters` 的分层骨架，但 `ports` 目录中的若干接口仍直接依赖 `core` 的具体类型，导致"端口层应当只表达契约"的原则被破坏。

具体表现为三个边界泄漏点：

- **驱动端口（Driving Port）泄漏**：`src/ports/driving/ChatUseCase.ts` 直接导入 `ApprovalService` 与 `AgentEvent` 两个核心实现类型，使得 CLI 或其它输入适配器在仅应接触契约的情况下，被迫感知核心的具体服务与事件结构。
- **被驱动端口（Driven Port）泄漏**：`src/ports/driven/tools/ToolAccessMetadataPort.ts` 引用 `core/usecases/security/SafetyResource`，`src/ports/driven/tools/AgentPlugin.ts` 引用 `core/usecases/plugins/plugin-types` 中的 `HookEventName` 和 `HookMiddleware`，导致端口层在实际上成为了核心类型的"转运层"而非稳定抽象层。
- **输入适配器越界**：`src/adapters/input/interface/facade.ts` 直接依赖 `SessionManager` 实体，而非仅依赖 `ChatUseCase` 驱动端口，导致 UI 层能接触到过多核心实现细节，替换输入方式时需要连带理解核心的内部结构。

若不加以收敛，随着系统演进，分层架构将沦为形式，适配器替换与测试 Mock 的成本无法真正降低。

## 变更内容

本变更分两步实施，遵循渐进式重构、每步可验证的原则：

**Step 1 — 端口契约收口**
- 将 `ChatUseCase` 接口上的 `ApprovalService` 属性替换为端口层自有审批契约或等价抽象。
- 将 `AgentEvent` 类型定义从 `core/usecases/engine/agent-loop.ts` 抬升到端口层拥有的位置，使驱动端口不再依赖核心实现文件。
- 同步收口 `ToolAccessMetadataPort` 对 `SafetyResource` 的引入：将该类型或其端口适用子集迁移至端口层拥有的位置，或在端口层定义纯 DTO 映射。
- 同步收口 `AgentPlugin` 对 `HookEventName` / `HookMiddleware` 的引入：原则同上，端口层只应引用端口自有的类型定义。

**Step 2 — 输入适配器依赖收敛**
- 将 `CliFacade` 对 `SessionManager` 的直接构造依赖替换为仅依赖 `ChatUseCase` 驱动端口。
- `CliFacade` 当前通过 `SessionManager` 调用的方法（`getIsGenerating`、`getModelName`、`abort`、`rollback`、`getHistory`、`handleUserInput`、`on`/`off`、`close`、`approvalService` 等）均需在 `ChatUseCase` 接口或补充契约中已声明，确保门面不再持有核心实体引用。

## 业务能力

### 新增业务能力
- `port-contract-isolation`: 端口契约纯度提升。端口层对外暴露的审批契约、事件类型、安全元数据与插件类型不再直接绑定 `core` 具体实现，使驱动端口与被驱动端口真正成为稳定抽象层。

### 修改业务能力

<!-- 纯技术重构，不涉及已有 spec 级别的需求行为变化，本次无修改业务能力。 -->

## 影响范围

- **`src/ports/driving/ChatUseCase.ts`** — 接口签名变更，`approvalService` 属性类型替换，`on`/`off` 方法的事件参数类型替换。
- **`src/core/usecases/engine/agent-loop.ts`** — `AgentEvent` 类型定义移至共享位置。
- **`src/core/usecases/security/ApprovalService.ts`** — 审批服务需适配新的端口层审批契约。
- **`src/ports/driven/tools/ToolAccessMetadataPort.ts`** — `ResourceExtractor` 返回值类型从 `SafetyResource` 替换为端口层自有类型。
- **`src/ports/driven/tools/AgentPlugin.ts`** — `hooks` 索引签名类型从 `HookEventName` / `HookMiddleware` 替换为端口层自有类型。
- **`src/adapters/input/interface/facade.ts`** — 构造函数参数由 `SessionManager` 替换为 `ChatUseCase`，内部方法调用同步调整。
- **`src/core/usecases/engine/session.ts`** — `SessionManager` 需实现调整后的 `ChatUseCase` 接口。
- 测试文件与 Mock 工厂需同步适配接口变更。
