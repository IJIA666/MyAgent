## 1. 建立统一命令分析契约

- [x] 1.1 在 `src/adapters/tools/impl/system/command-analysis/` 新增带标准 TSDoc 的分析类型与分发入口，定义 `parsed | unsupported | invalid`、`atomic | compound | nested`、有序子命令、连接关系、副作用等级及不可逆的 hardline deny 证据。
- [x] 1.2 分别实现 Bash、PowerShell、Cmd 分析器；先锁定原子命令行为，再用分 Shell、引号与转义感知的扫描器支持 Bash 顶层 `;`/`&&`/`||` 和 PowerShell 顶层 `;`，CMD 复合语法继续返回 `unsupported`，不得在阶段 3 引入完整 AST 依赖。
- [x] 1.3 实现先于支持度判断的 hardline 扫描，并正确区分引号内字面量与真实操作符，保证后续降级、解析失败或模式规则不能把 deny 改写为 ask/allow。
- [x] 1.4 为复合分析增加最多 50 个子命令的上限；管道、重定向、后台执行、换行、嵌套、控制流及命令替换继续返回 `unsupported`，不进入执行。
- [x] 1.5 新增 `test/adapters/tools/command-analysis.test.ts`，覆盖三种 shell、已支持连接符、连接语义、引号字面量、未支持复杂结构、子命令上限、无效语法和 hardline 不可降级。

<!-- checkpoint: npx vitest run test/adapters/tools/command-analysis.test.ts -->

## 2. 让 Terminal 只消费统一分析结果

- [x] 2.1 重构 `src/adapters/tools/impl/system/terminal-guard.ts`，移除会覆盖 hardline 结论的分散解析与副作用推断，改为消费统一命令分析结果并保留明确拒绝原因。
- [x] 2.2 更新 `src/adapters/tools/impl/system/terminal.ts` 的权限检查与执行前校验：允许分析成功的原子命令和基础复合命令进入授权流程，保持原始连接语义执行；`unsupported` 与 `invalid` 统一拒绝。
- [x] 2.3 更新 `test/adapters/tools/terminal.test.ts`，用新契约替换旧的复合正则硬拒绝断言，覆盖 Bash 三种连接符、PowerShell 分号、带引号分号、短路语义和复杂结构仍拒绝。

<!-- checkpoint: npx vitest run test/adapters/tools/terminal.test.ts -->

## 3. 统一权限证据与优先级

- [x] 3.1 在 `src/core/domain/permissions/permission-types.ts` 为 `ToolPermissionCheckResult`、`PermissionDecision` 增加通用 `ToolPermissionEvidence`，使核心权限层可以携带命令分析证据而不依赖 Terminal 适配器类型，并为公开类型补齐标准 TSDoc。
- [x] 3.2 修改 `src/core/domain/permissions/tool-permission-service.ts`，每次权限评估只调用一次工具权限检查器，并按 `deny > ask > allow` 汇总全局规则、模式规则、工具级结果和全部子命令结果；显式 ask 不得跳过任一子命令 hardline deny。
- [x] 3.3 更新 Terminal 的权限检查器，将同一份有序子命令与聚合证据写入权限结果；禁止在权限服务或提示阶段重新解析命令。
- [x] 3.4 扩充 `test/core/permissions/tool-permission-service.test.ts` 与 `test/contract/permission-contract.test.ts`，覆盖多子命令 allow、混合 ask、任一 deny、规则与工具结果冲突、一次分析、证据透传及 hardline 优先级。

<!-- checkpoint: npx vitest run test/core/permissions/tool-permission-service.test.ts test/contract/permission-contract.test.ts -->

## 4. 收口授权编排与执行副作用

- [x] 4.1 扩展 `src/adapters/tools/ToolCallGateway.ts`，由网关统一完成权限检查、ask 交互、授权上下文创建与执行；`deny` 不得进入提示或执行，用户拒绝不得创建授权上下文。
- [x] 4.2 将 `src/core/usecases/plugins/PermissionPromptAdapter.ts` 接入网关 ask 分支，统一 `PermissionUpdate` 的本次/会话授权语义；复合命令只提示一次，只为需要批准的原子子命令生成规则，单次最多建议 5 条，禁止持久化完整复合字符串。
- [x] 4.3 简化 `src/adapters/tools/toolRegistry.ts` 的内置工具与 MCP 工具路径，使其只负责查找和路由并调用网关，不再复制权限判断、等待审批或构造静态安全结论。
- [x] 4.4 修改 `src/adapters/tools/ToolExecutor.ts` 与授权上下文类型，将权限阶段产生的子命令证据和聚合副作用映射为真实 `ExecutionEffect`；删除 Registry 对 effect/securityCategory 的执行后覆盖。
- [x] 4.5 更新 `test/contract/gateway-contract.test.ts`、`test/contract/tool-call-orchestration.test.ts` 和 `test/integration/runtime-effect-lifecycle.test.ts`，覆盖原子/复合 allow、聚合 ask/deny、一次提示、用户批准/拒绝、按子命令更新规则、内置/MCP 一致性和证据到 effect 的单链路传播。

<!-- checkpoint: npx vitest run test/contract/gateway-contract.test.ts test/contract/tool-call-orchestration.test.ts test/integration/runtime-effect-lifecycle.test.ts -->

## 5. 删除旧权限与安全分析路径

- [x] 5.1 删除 `src/ports/shared/tool-policy.ts`、`src/adapters/tools/builtin-tool-policy-adapter.ts`、`src/adapters/tools/external-tool-policy-adapter.ts` 和 `src/adapters/tools/tool-policy-router.ts`，并清理 `ToolPolicyPort`、`checkSafety`、`SafetyCheckResult`、`resolveExecutionEffect` 的全部生产引用与导出。
- [x] 5.2 删除 `src/core/usecases/plugins/HumanApprovalPlugin.ts` 及其旧组合测试，清理 `src/core/usecases/plugins/plugin-types.ts` 中仅为旧审批插件存在的类型，保留与新 `PermissionPromptAdapter` 仍有关的交互契约。
- [x] 5.3 清理 `src/core/usecases/engine/session.ts`、运行时装配入口和 `toolRegistry.ts` 中遗留的 policy port/access metadata 注入参数，确保启动装配只存在新权限服务、网关和提示适配器一条路径。
- [x] 5.4 更新受删除契约影响的工具实现与测试桩，不保留兼容包装器；公开 API 的新增或修改注释遵循标准 TSDoc，私有辅助函数使用轻量职责注释。

<!-- checkpoint: npx tsc --noEmit -->

## 6. 阶段 3 验收与边界回归

- [x] 6.1 增加零残留断言或静态检索验收，确认生产源码中 `ToolPolicyPort`、`checkSafety`、`SafetyCheckResult`、`HumanApprovalPlugin`、旧 policy adapters/router 均为零引用。
- [x] 6.2 执行阶段 3 重点回归，确认原子命令和已支持基础复合命令可按权限模式运行、连接短路语义不变、hardline 始终拒绝、每次复合调用至多提示一次、权限证据只分析一次且执行 effect 与其一致。
- [x] 6.3 明确记录阶段边界：本 change 不实现沙盒，不删除自动代码质量门禁，不支持管道、重定向、后台执行、换行、子 Shell、命令替换、脚本块、控制流和 CMD 复合语法；原阶段 5 仅负责扩展这些复杂复合结构。

<!-- checkpoint: npx vitest run test/adapters/tools/command-analysis.test.ts test/adapters/tools/terminal.test.ts test/core/permissions/tool-permission-service.test.ts test/contract/gateway-contract.test.ts test/integration/runtime-effect-lifecycle.test.ts -->
