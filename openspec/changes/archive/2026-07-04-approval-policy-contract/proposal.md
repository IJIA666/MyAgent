## 改造原因

当前审批系统存在三个结构性问题，导致新增审批场景需要同时改三层代码：

1. **UI 层硬编码 choice 集**：`facade.ts` 通过 `allowedPrefix` 的有无猜测权限语义（`once/always/deny` vs `once/deny`），新增审批类型需要改动 UI 渲染逻辑。
2. **工具层缺乏标准化操作描述**：`checkSafety()` 返回 `SafetyCheckResult` 时，授权语义（read/write、路径数量）散落在 `targetPath` 和 `resources` 字段中，没有统一的 `SafetyOperation` 契约。
3. **没有中央策略层**：choice 生成逻辑散落在 `HumanApprovalPlugin` 和 `facade.ts` 两处，无法根据操作类型、风险等级和 WorkMode 动态决定可用的选择项集合。

此前 `approval-capability-lifecycle` 已完成了授权执行能力（call/session 令牌生命周期、pendingGrant 提交、access-aware 校验），本 change 在上层补全策略契约和标准化操作描述。

## 变更内容

1. **引入 `SafetyOperation` 标准化操作描述**：工具 `checkSafety()` 返回的操作描述接口，包含原子资源列表、风险原因、操作类别和人类可读摘要。替代当前散落的多字段格式。
2. **新增 `ApprovalPolicy` 中央策略服务**：接收 `SafetyOperation`，输出 `ApprovalRequest`（含受信的 choice 列表 + 校验后的资源）。choice 列表由策略层根据资源类型、WorkMode 和已有规则动态生成，UI 不再自行推导。
3. **重构 `HumanApprovalPlugin` 审批映射**：从硬编码的 `once/always → pendingGrant` 映射改为从 `ApprovalPolicy` 获取受信的 `choiceId` 集合，调用 `mapChoiceToEffect()` 生成 `PendingGrant | PersistentRuleEffect | deny`。`persistent` 类型仅对命令前缀生效。
4. **审批决策传输契约升级**：`ApprovalService` 的外部决策动作从 `once/always/deny` 迁移为 `ApprovalChoiceId`（`call/session/persistent/deny`），并把 `ApprovalRequest` 元数据传递给 UI。这样 UI 才能真正做到“渲染策略层下发的 choices，然后原样回传 choiceId”，而不是继续保留语义猜测层。
5. **UI 层缩编**：`facade.ts` 不再硬编码 choice 列表，改为从 `ApprovalRequest.choices` 渲染选项，`deny` 作为显式终态参与建模。
6. **资源提取器注册机制**：每个内置工具注册一个资源提取器函数，`ApprovalPolicy` 用它从原始 `toolCall.arguments` 重新计算资源，与 `checkSafety()` 报告的 `SafetyResource` 比对。第三方工具无可信提取器，默认只允许 `call` 级审批。

**不涉及**：
- 工具层 `checkSafety()` 的新增 API（如 `ReadFileTool`、`WriteFileTool` 等）——本 change 只定义 `SafetyOperation` 接口契约，工具迁移由后续 change 完成
- 持久化命令前缀白名单的落盘逻辑（`SecurityService` 已有此能力）
- 命令行模式（CLI）以外的 UI 通道（IDE 插件等）

## 业务能力

### 新增业务能力
- `approval-policy-contract`: 中央审批策略层，负责校验 `SafetyOperation`、生成受信的 `ApprovalChoice` 列表和资源提取器注册机制

### 修改业务能力
- `human-approval`: `HumanApprovalPlugin` 的 choice 映射逻辑从硬编码改为委托 `ApprovalPolicy`；`persistent` 类型仅对命令前缀生效；审批决策传输动作升级为 `ApprovalChoiceId`
- `approval-capability-lifecycle`: 新增 `PersistentRuleEffect` 授权效果类型，与现有 `PendingGrant`（call/session）平行，并由 `AgentLoop` 的授权效果提交逻辑统一处理

## 影响范围

- **`src/core/usecases/security/ApprovalPolicy.ts`**（新文件）— 中央审批策略服务
- **`src/core/usecases/plugins/plugin-types.ts`** — 新增 `SafetyOperation`、`ApprovalChoice`、`ApprovalRequest`、`PersistentRuleEffect` 类型；`SafetyCheckResult` 新增 `operation?: SafetyOperation` 字段
- **`src/core/usecases/security/ApprovalService.ts`** — 审批决策动作升级为 `ApprovalChoiceId`，审批处理器需携带 `ApprovalRequest`
- **`src/core/usecases/plugins/HumanApprovalPlugin.ts`** — 审批映射逻辑委托 `ApprovalPolicy`；支持 `persistent` effect
- **`src/core/usecases/engine/session.ts`** — 组合根负责装配 `ApprovalPolicy` 并注入 `HumanApprovalPlugin`
- **`src/adapters/input/interface/facade.ts`** — UI 从 `ApprovalRequest.choices` 渲染选项，并回传 `choiceId`
- **`src/core/usecases/engine/agent-loop.ts`** — `suspend` 事件类型补充 `ApprovalRequest` 元数据；授权效果提交逻辑新增 `PersistentRuleEffect` 处理分支
- **`src/adapters/tools/virtual-mcp.ts`** — 内置工具的中央资源提取器注册表
