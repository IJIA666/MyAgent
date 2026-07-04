## 1. 类型定义扩展

- [x] 1.1 在 `plugin-types.ts` 中定义 `SafetyOperation` 接口：`{ resources: SafetyResource[]; riskReason: string; operationCategory: 'file-read'|'file-write'|'file-edit'|'file-delete'|'file-move'|'file-copy'|'command-execute'; summary: string }`
- [x] 1.2 在 `plugin-types.ts` 中定义 `ApprovalChoiceId` 类型：`'call' | 'session' | 'persistent' | 'deny'`
- [x] 1.3 在 `plugin-types.ts` 中定义 `ApprovalChoice` 接口：`{ choiceId: ApprovalChoiceId; label: string; description?: string }`
- [x] 1.4 在 `plugin-types.ts` 中定义 `ApprovalRequest` 接口：`{ id: string; message: string; choices: ApprovalChoice[] }`
- [x] 1.5 在 `plugin-types.ts` 中 `SafetyCheckResult` 新增 `operation?: SafetyOperation` 字段
- [x] 1.6 在 `plugin-types.ts` 中定义 `PersistentRuleEffect` 类型：`{ type: 'persistent'; prefix: string }`，并与 `PendingGrant` 组成 `ApprovalEffect` 联合类型
- [x] 1.7 在 `ApprovalService.ts` 中将 `ApprovalDecision.action` 升级为 `ApprovalChoiceId`（`call | session | persistent | deny`）
- [x] 1.8 在 `ApprovalService.ts` 中扩展审批处理器入参，使其可携带 `ApprovalRequest` 或等价的 `choices/message` 元数据给 UI

<!-- checkpoint: npx tsc --noEmit -->

## 2. ApprovalPolicy 中央策略服务

- [x] 2.1 创建 `src/core/usecases/security/ApprovalPolicy.ts`，实现 `ApprovalPolicy` 类
- [x] 2.2 实现 `resourceExtractors: Map<string, ResourceExtractor>` 注册表
- [x] 2.3 实现 `resolve({ toolName, toolArgs, operation, workMode })` 方法：提取器交叉校验 + choice 生成
- [x] 2.4 实现 `mapChoiceToEffect(choiceId, operation, toolName)` 静态方法
- [x] 2.5 实现 choice 生成规则矩阵（path+read → call/session/deny, path+write → call/session/deny, command-prefix → call/persistent/deny, hardline → deny, untrusted → call/deny）

<!-- checkpoint: npx tsc --noEmit -->

## 3. 资源提取器注册

- [x] 3.1 在 `virtual-mcp.ts` 中定义 `ResourceExtractor` 类型：`(args: Record<string, unknown>) => SafetyResource[]`
- [x] 3.2 在 `LocalFileSystemMcpServer` 中新增 `registerResourceExtractor(toolName: string, extractor: ResourceExtractor): void` 方法
- [x] 3.3 为所有内置文件工具注册提取器（WriteFile、EditFile、ReadFile、ReadManyFiles、ListFiles、CreateDirectory、DeletePath、MovePath、CopyPath、ApplyPatch、GrepSearch）
- [x] 3.4 为 ExecuteCommandTool 注册命令前缀提取器
- [x] 3.5 `ApprovalPolicy` 在构造时注入提取器注册表引用

<!-- checkpoint: npx tsc --noEmit -->

## 4. HumanApprovalPlugin 适配

- [x] 4.1 在 `HumanApprovalPlugin` 构造函数中注入 `ApprovalPolicy` 实例
- [x] 4.2 `beforeToolMiddleware` 中：在 `suspend` 分支调用 `ApprovalPolicy.resolve()` 生成 `ApprovalRequest`
- [x] 4.3 将 `ApprovalRequest.choices` 与 `message` 附加到 `suspend` 事件中，并同步更新 `AgentEvent` 的 `suspend` 载荷类型
- [x] 4.4 `beforeToolMiddleware` 中：用户决策后调用 `ApprovalPolicy.mapChoiceToEffect(choiceId, operation, toolName)` 获取授权效果
- [x] 4.5 根据效果类型（call/session/persistent/deny）构造 `context.pendingGrant` 或 `context.persistentRuleEffect`
- [x] 4.6 实现 `SafetyOperation` 缺失时的降级组装逻辑（从 `safetyResult` 旧字段推断）
- [x] 4.7 在 `session.ts` 组合根中装配 `ApprovalPolicy`，并将其实例注入 `HumanApprovalPlugin`

<!-- checkpoint: npx tsc --noEmit -->

## 5. facade.ts UI 适配

- [x] 5.1 从 `suspend` 事件中读取 `choices: ApprovalChoice[]`
- [x] 5.2 遍历 `choices` 渲染审批选项按钮（label + description）
- [x] 5.3 用户选择后仅返回 `choiceId`，不再硬编码 `once/always/deny` 推导
- [x] 5.4 保留 `choices` 缺失时的降级逻辑（使用 `allowedPrefix` 推导）

<!-- checkpoint: npx tsc --noEmit -->

## 6. AgentLoop 授权效果提交

- [x] 6.1 在授权效果提交逻辑中新增 `persistentRuleEffect` 处理分支，不再把 `persistent` 伪装成 `pendingGrant`
- [x] 6.2 `persistent` 分支调用 `SecurityService.getInstance().saveSecurityAllowlist()` 追加命令前缀规则
- [x] 6.3 HOOK 上下文新增 `persistentRuleEffect?: PersistentRuleEffect` 字段（Section 1 中已完成）

<!-- checkpoint: npx tsc --noEmit -->

## 7. 单元测试

- [x] 7.1 `ApprovalPolicy.resolve()` choice 生成测试（覆盖所有资源类型 + hardline + 第三方工具）— `ApprovalPolicy.test.ts`
- [x] 7.2 `ApprovalPolicy.mapChoiceToEffect()` 映射测试（call/session/persistent/deny + 降级场景）— `ApprovalPolicy.test.ts`
- [x] 7.3 `HumanApprovalPlugin` 委托 `ApprovalPolicy` 的行为测试 — `human-approval-pending-grant.test.ts`（已有测试适配）
- [x] 7.4 提取器交叉校验测试（匹配/不匹配/无提取器）— `ApprovalPolicy.test.ts`
- [x] 7.5 `SafetyOperation` 降级组装测试 — `HumanApprovalPlugin.buildSafetyOperation()`
- [x] 7.6 `ApprovalService` 决策动作迁移测试（`call/session/persistent/deny`）— `ApprovalService.test.ts`（已有测试适配）
- [x] 7.7 `CliFacade` 基于 `ApprovalRequest.choices` 的渲染与回传测试 — `CliFacade.test.ts`（已有测试适配）

<!-- checkpoint: npm run test -->

## 8. 端到端验证

- [x] 8.1 验证文件写操作 → choices 为 [call, session, deny] — `ApprovalPolicy.test.ts` 覆盖
- [x] 8.2 验证命令操作 → choices 为 [call, persistent, deny] — `ApprovalPolicy.test.ts` 覆盖
- [x] 8.3 验证 hardline 命令 → choices 仅为 [deny] — `ApprovalPolicy.test.ts` 覆盖
- [x] 8.4 验证敏感文件 → choices 不包含 session — `ApprovalPolicy.test.ts` 覆盖
- [x] 8.5 验证 persistent choice → 命令前缀写入磁盘白名单 — `agent-loop.ts` 持久化分支 + 集成测试覆盖
- [x] 8.6 验证 UI 降级：旧 suspend 事件（无 choices）仍正常渲染 — `CliFacade.test.ts` 降级路径覆盖

<!-- checkpoint: npm run test -->
