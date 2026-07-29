## 1. 冻结 Claude 行为基线与真实运行面

- [x] 1.1 在 `test/fixtures/permissions/claude/` 建立版本化 fixture，分别记录 Manual、Accept edits on、Plan、显式 deny/ask/allow、默认/custom memory 根、额外目录和 MCP 精确调用的输入与静态 expected outcome；每条 fixture 注明官方文档 URL 或 `D:/projects/Agents/claude-code-analysis` 源码位置，不调用 MyAgent service 生成 expected。
- [x] 1.2 重写 `test/core/permissions/behavior-fixtures.test.ts` 的 fixture loader，使其校验 runtime tool、permission identity、真实参数、mode、rules、expected decision、expected actions 和 intentional-difference 标记；拒绝缺少来源或只包含假想 PascalCase runtime tool 的 fixture。
- [x] 1.3 在 `src/adapters/tools/` 增加带标准 TSDoc 的 effectful entrypoint manifest，枚举 NativeTool、MCP、tail call、Terminal、插件和内部 helper 的执行入口；在 `test/contract/tool-runtime.test.ts` 增加”ToolCatalog 有副作用项与 manifest 一一对应”的结构测试。
- [x] 1.4 在 `test/contract/permission-contract.test.ts` 添加真实链路基线：`default + writeFile` 首次 ask、`acceptEdits + writeFile/editFile/applyPatch/createDirectory`、`default + built-in memoryDir`、Plan 写入拒绝和 prompt 缺失 fail closed；暂不复制旧 service 自参照断言。
- [x] 1.5 在 `test/contract/gateway-contract.test.ts` 固化现有正确不变量：所有本地/MCP 调用先授权、`ToolExecutor` 拒绝直接调用、服务签发上下文单次消费、执行超时从授权后开始。
- [x] 1.6 在 `test/contract/permission-zero-residual.test.ts` 建立零残留扫描框架和当前允许清单，目标符号包括 `WorkMode`、`ApprovalPolicy`、`SafetyCheckResult`、`SafetyOperation`、`PendingGrant`、`CallCapability`、旧 temporary whitelist 与 Auto 生产入口；后续阶段逐项把允许计数收敛为零。

<!-- checkpoint: npx vitest run test/core/permissions/behavior-fixtures.test.ts test/contract/gateway-contract.test.ts test/contract/tool-runtime.test.ts -->

## 2. 移除未交付 Auto 与修正模式配置边界

- [x] 2.1 修改 `src/core/domain/permissions/permission-types.ts` 和 `src/config/types.ts`，从生产 `PermissionMode`/`ConfigPermissionMode` 删除 `auto`，保留 `default | acceptEdits | plan | dontAsk | bypassPermissions`，同步更新公开 TSDoc 与默认常量。
- [x] 2.2 修改 `src/core/domain/permissions/mode-manager.ts`，删除 `isDangerousAllowRule()`、Auto 规则剥离缓存和 `enterAuto()/exitAuto()`；保留并测试 `prePlanMode` 的进入、恢复与失效回退。
- [x] 2.3 删除 `src/core/domain/permissions/auto-classifier.ts`，移除 `ToolPermissionServiceOptions.autoClassifier`、`handleAutoMode()` 和所有 classifier decision 分支；分类器缺失不得再形成一个可选的虚假生产能力。
- [x] 2.4 修改 `src/config/loader.ts`、`src/adapters/tools/impl/system/terminal-config.ts` 和 settings schema 的 mode 校验：旧 `auto` 值记录去敏迁移告警并回退 `default`；project/local 来源的 `bypassPermissions` 必须拒绝。
- [x] 2.5 修改 `src/adapters/input/interface/commands/workmode.ts`、`commands/help.ts`、`views/widget-renderer.ts` 和相关 facade 状态文案，普通入口只显示 `Manual / Accept edits on / Plan`；`dontAsk`、`bypassPermissions` 仅接受受信显式高级参数并展示风险。
- [x] 2.6 重写 `test/core/permissions/mode-manager.test.ts`、`test/config/loader.test.ts`、`test/adapters/input/interface/commands/workmode.test.ts`：覆盖 Auto 配置回退、普通 picker 无 Auto、Plan 从 Accept edits on 进入并恢复、项目配置不能启用 bypass。

<!-- checkpoint: npx vitest run test/core/permissions/mode-manager.test.ts test/config/loader.test.ts test/adapters/input/interface/commands/workmode.test.ts -->
<!-- checkpoint: npx tsc --noEmit -->

## 3. 建立单一 PermissionSessionState 与动作联合

- [x] 3.1 新增 `src/core/domain/permissions/permission-session-state.ts`，定义带标准 TSDoc 的 `PermissionSessionState`、`PermissionSessionSnapshot` 和模式迁移记录；实现 mode/prePlanMode、resolved/session rules、additionalDirectories、`stateVersion` 及不可变快照。
- [x] 3.2 修改 `src/core/domain/context.ts`、`src/core/usecases/engine/session.ts` 和 `src/ports/driven/session/SessionEventPort.ts`，由每个 `SessionContext` 创建并拥有唯一 PermissionSessionState；删除独立模式缓存、临时权限状态和重复规则来源。
- [x] 3.3 修改 `src/adapters/tools/toolRegistry.ts`、`ToolCallGateway.ts` 和 `src/core/domain/permissions/tool-permission-service.ts` 的构造参数，使它们共享当前会话的 state/rule view，而不是 ToolRegistry 自建进程级 RuleStore；无 session 的 headless 调用使用显式受限 state。
- [x] 3.4 在 `src/core/domain/permissions/permission-types.ts` 将 `PermissionUpdate` 改成 `addRules | replaceRules | removeRules | setMode | addDirectories | removeDirectories` 的穷尽判别联合，动作携带 `session | projectLocal | project | user` 目标并禁止 managed 目标。
- [x] 3.5 修改 `src/core/domain/permissions/rule-store.ts` 和 PermissionSessionState，提供“整体验证后单次提交”的 `applyUpdates()`；任一动作非法时不修改 rules、mode、directories 或 stateVersion。
- [x] 3.6 修改 `src/core/domain/permissions/mode-manager.ts` 或将其职责收敛进 PermissionSessionState：会话 `setMode` 不落盘，进入 Plan 保存前态，退出时恢复仍被 host policy 允许的前态，否则回退 Manual。
- [x] 3.7 新增 `test/core/permissions/permission-session-state.test.ts`，覆盖会话隔离、原子多动作、stateVersion、Plan 恢复、invalid update 回滚和旧 grant 版本失效；更新 `test/contract/session-persistence.test.ts`，证明新会话只读取未来默认而不恢复临时会话 mode。

<!-- checkpoint: npx vitest run test/core/permissions/permission-session-state.test.ts test/core/permissions/rule-store.test.ts test/contract/session-persistence.test.ts -->
<!-- checkpoint: npx tsc --noEmit -->

## 4. 引入有类型工具适配器与正式资源证据

- [x] 4.1 在 `src/core/domain/permissions/` 新增正式 `PermissionRequest`、`PermissionIdentity`、`ApprovalAction` 和资源证据判别联合；覆盖 file、directory-scope、command、network、external-side-effect、mcp-call、unknown，并要求 raw/canonical resource、operation、scope、sourceNodeId、protected、provenance、trust。
- [x] 4.2 删除 `ToolPermissionResourceEvidence` 中的 `Readonly<Record<string, unknown>>` 兼容口及相关运行时字段探测，迁移 `permission-types.ts`、effect 结构和日志序列化为新联合；未知 effectful 资源必须显式为 unknown。
- [x] 4.3 新增 `src/ports/driven/tools/ToolAuthorizationAdapter.ts`，定义 `runtimeToolName`、稳定 permission identity、输入规范化、资源构造、Edit 分类和 approval actions；所有公开接口使用标准 TSDoc。
- [x] 4.4 修改 `src/adapters/tools/tool-types.ts`、`ToolCatalog.ts`、`src/adapters/tools/index.ts` 和原生工具组合函数，使 effectful NativeTool 注册时强制携带 adapter，ToolCatalog 能枚举覆盖，注册缺失或重复 identity 时 fail closed。
- [x] 4.5 新增 `src/adapters/tools/permissions/file-tool-authorization.ts`，显式映射 `readFile → Read`、`writeFile → Write`、`editFile/applyPatch → Edit`、`createDirectory → Write`，并把 `deletePath/movePath/copyPath` 标记为独立 destructive 操作；解析各工具真实 `targetPath/directoryPath/sourcePath/destinationPath`。
- [x] 4.6 收敛 `bash-permissions.ts`、`powershell-permissions.ts`、`shell-permission-evidence.ts` 为 Shell ToolAuthorizationAdapter：复用现有 AST/复合命令分析，逐节点生成 command/network/file 证据和安全规则建议，中央服务不得重复解析字符串。
- [x] 4.7 修改 `src/adapters/tools/toolRegistry.ts` 的外部 descriptor 装配，使用专属 MCP adapter 产生 server/tool/descriptorVersion、参数摘要和 external-claimed evidence；删除”annotations readOnly 即工具 allow”的当前分支。
- [x] 4.8 在 `ToolPermissionService.checkPermissions()` 旁新增 `checkRequest()` 方法，接收 PermissionRequest 和 PermissionSessionState，使用 PermissionIdentity 替代 isKnownReadOnlyTool 等字符串猜测。
- [x] 4.9 新增 `test/adapters/tools/tool-authorization-adapters.test.ts` 和 `test/core/permissions/resource-evidence.test.ts`，逐一覆盖真实文件参数、Shell wrapper/MCP claim、物理路径、provenance、缺失 adapter 和未知资源；更新 `test/contract/tool-runtime.test.ts` 做全 ToolCatalog 覆盖。

<!-- checkpoint: npx vitest run test/adapters/tools/tool-authorization-adapters.test.ts test/core/permissions/resource-evidence.test.ts test/core/permissions/tool-permission-service.test.ts test/contract/tool-runtime.test.ts -->
<!-- checkpoint: npx tsc --noEmit -->

## 5. 接入 host cap、受保护资源与 caller trust

- [x] 5.1 新增 `src/core/domain/permissions/trusted-call-context.ts`，定义宿主验证的 callerId、channelTrust、audience、parentAgent 和 policyVersion；入口未验证时使用明确的 untrusted caller，而不是只凭 session id。
- [x] 5.2 新增 `src/core/domain/permissions/protected-resource-policy.ts`，按 managed host、trusted user host、project/local、session、tool candidate 组合 stricter-wins，并产出可解释的压制链；低层 allow 不得覆盖高层 ask/deny。
- [x] 5.3 在 protected policy 中覆盖 `.git`、`.myagent/settings*.json`、`.myagent/rules`、hooks、启动配置、IDE 自动执行配置、`.env`、provider/browser/MCP credentials、工作区/用户/磁盘根和其他项目数据。
- [x] 5.4 在 `protected-resource-policy.ts` 中通过 NetworkResourceEvidence 分支支持 network 资源策略；`checkProtectedResource` 使用 same host floor for all channels。
- [x] 5.5 `auto-memory-agent.ts` 的 `createAutoMemCanUseTool()` 使用独立受限工具策略，子 Agent 继承父级快照不扩权；新 Agent 创建时取父级最终有效规则和目录快照。
- [x] 5.6 `trusted-call-context.ts` 定义 `UNTRUSTED_CALLER`；未验证 caller 使用 untrusted identity 且 `isLocalInteractive: false`，不绑定 session grant。
- [x] 5.7 新增 `test/core/permissions/protected-resource-policy.test.ts` 和 `test/integration/caller-trust-inheritance.test.ts`，覆盖 managed deny 压制项目 allow、Accept edits 写 protected path、SSRF、远程 session-id 复用、子 Agent 工具/目录不扩权。

<!-- checkpoint: npx vitest run test/core/permissions/protected-resource-policy.test.ts test/integration/caller-trust-inheritance.test.ts -->

## 6. 修通文件编辑、Accept edits on 与额外目录

- [x] 6.1 修改 `ToolCallGateway.ts`，在工具注册时提取 authorizationAdapter，在 execute 中有适配器时使用 `checkRequest` 适配器感知路径替代旧字符串猜测路径。
- [x] 6.2 修改 ToolPermissionService 的 mode 阶段，仅依据 adapter 的普通 Edit 分类放行 `writeFile/editFile/applyPatch/createDirectory`；`deletePath/movePath/copyPath`、Terminal 写入、external side effect 保持各自 ask/deny。
- [x] 6.3 在 `file-tool-authorization.ts` 的 `buildApprovalOptions` 中为普通编辑构造三项动作：Allow once、Allow and turn on Accept edits for this session、Deny；第二项只携带 `setMode(acceptEdits, session)`，不创建宽泛路径规则。
- [x] 6.4 将 `additionalDirectories` 接入 PermissionSessionState（已完成 3.1/3.4）、正式 file/directory evidence（已完成 4.1 中的 DirectoryScopeEvidence）和物理路径解析（base.ts 中的 `isWithinAnyAuthorizedRoot` 支持 additionalDirs 参数）。
- [x] 6.5 在 `file-tool-authorization.ts` 的 `buildApprovalOptions` 中，对普通编辑提供 `allowOnce`、`allowAndSetMode(acceptEdits)`、`deny`；Allow once 不加目录。
- [x] 6.6 更新 `src/adapters/tools/impl/base.ts` 的 `secureResolveReadPath` 和 `secureResolveWritePath` 从 `PermissionSessionState.getAdditionalDirectories()` 读取会话额外目录并传入 `isWithinAnyAuthorizedRoot`。
- [x] 6.7 新增 `test/adapters/tools/file-permission-adapters.test.ts`、`test/core/permissions/additional-directories.test.ts`，并扩展 `permission-contract.test.ts` 覆盖 Manual 首问、模式切换、后续免问、protected path、外部 Allow once、显式加目录、兄弟前缀和 destructive 操作。

<!-- checkpoint: npx vitest run test/adapters/tools/file-permission-adapters.test.ts test/core/permissions/additional-directories.test.ts test/contract/permission-contract.test.ts -->

## 7. 重写 ask-only 审批与原子设置持久化

- [x] 7.1 修改 `src/core/usecases/plugins/PermissionPromptAdapter.ts`，将 `PromptResponse.scope` 替换为可信 `actionId`；移除 `buildUpdateFromDecision()` 和 `getRuleSuggestions()` 旧方法。
- [x] 7.2 修改 `src/adapters/tools/toolRegistry.ts` 的 `createPromptAdapter()` 和 CLI approval choices，从 ApprovalAction 构建选择项；无工具适配器提供的安全可复用动作时只显示单次允许/拒绝，禁止从 `ruleSuggestions` 猜测持久规则。
- [x] 7.3 扩展 `src/config/settings-repository.ts`，为权限规则和未来默认模式提供版本/摘要 CAS、临时文件写入、原子替换与失败恢复；保留同文件 terminal/model 等未修改字段。
- [x] 7.4 修改 `src/adapters/tools/PermissionSettingsStore.ts`，按 PermissionUpdate 判别联合验证可写来源；持久更新等待磁盘成功后再提交 PermissionSessionState，managed 来源和非法组合直接拒绝。
- [x] 7.5 修改 `ToolCallGateway.authorize()`，只有 action 整体提交成功才把 ask 转成 allow 并签发后续 grant；持久化失败、CAS 冲突、UI 取消/超时或缺失均产生未执行的权限生命周期错误。
- [x] 7.6 删除 `src/core/usecases/security/ApprovalPolicy.ts`、`ApprovalService.ts` 及未使用旧 `SecurityService` 审批职责，移除组合根注册和依赖；保留仍有非审批职责的模块时先拆分并重命名，禁止遗留同名空壳。
- [x] 7.7 重写 `test/core/permissions/approval-flow.test.ts`、`test/adapters/tools/permission-settings-store.test.ts`、`test/config/settings-repository.test.ts`；删除 `ApprovalPolicy.test.ts`、`ApprovalService.test.ts` 和旧 `human-approval-pending-grant.test.ts`，新增 action 渲染、原子多动作、CAS 冲突和 session 隔离覆盖。

<!-- checkpoint: npx vitest run test/core/permissions/approval-flow.test.ts test/adapters/tools/permission-settings-store.test.ts test/config/settings-repository.test.ts -->
<!-- checkpoint: npx tsc --noEmit -->

## 8. 复刻 Claude Auto Memory 三条路径

- [x] 8.1 在 `src/config/types.ts`、loader、settings schema 和 `application-paths.ts` 增加 `autoMemoryEnabled`（默认 true）与 `autoMemoryDirectory`；自定义值只接受规范化绝对/home-relative 路径，project/local 来源在 workspace trust 前忽略。
- [x] 8.2 重构 `src/core/usecases/brain/memory-loader.ts`：上限从 20KB 改为 25KB，启动只读取 `MEMORY.md` 前 200 行/25KB 的完整内容和截断诊断，不再逐个打开 topic frontmatter。
- [x] 8.3 修改 `MemorySnapshot` 和 `model-request-assembler.ts` 的 projection，注入被转义并带低权限边界的有界 `MEMORY.md` 内容；保持 `SessionManager.open()` 自动刷新，`autoMemoryEnabled=false` 时完全不投影。
- [x] 8.4 在 `src/adapters/tools/permissions/memory-path-policy.ts` 实现带标准 TSDoc 的 `isAutoMemPath()`、`isAgentMemoryPath()` 和默认/custom 根判定；增加 `checkMemoryPermission()` 按 Claude 语义返回 allow/ask/deny/none，显式 deny/hard cap 先于特例。
- [x] 8.5 将 memory path policy 接入 file adapters 与 `src/adapters/tools/impl/base.ts`：精确默认根可达且维护写免审批；`.myagent` 父目录、相邻项目数据、settings/instructions、删除/移动/执行不继承。
- [x] 8.6 在 `memory-path-policy.ts` 的 `checkMemoryPermission()` 中实现 custom memory 语义：主 Agent 对可信 custom 根读取 allow，写入走普通规则/模式；显式 deny/hard cap 先于特例。
- [x] 8.7 新增 `src/core/usecases/brain/auto-memory-agent.ts` 或等价 forked agent 入口和 `createAutoMemCanUseTool(memoryDir)`：允许 Read/Grep/Glob、只读 Bash、根内 Edit/Write，拒绝其他工具；使用独立 caller、审计来源和 ToolGateway。
- [x] 8.8 扩展 `/memory` 现有入口或新增管理模块，提供 Auto Memory 开关、显式 topic 诊断、provenance 和候选暂存管理；topic 诊断不得重新变成会话启动的隐式读取。
- [x] 8.9 重写 `test/core/usecases/brain/memory-loader.test.ts`、`test/contract/long-term-memory.test.ts`、`SessionManager.test.ts`，新增 `memory-permissions.test.ts` 与 `auto-memory-agent.test.ts`，覆盖 200行/25KB、topic 按需、默认免问、custom 写询问、父目录拒绝、后台写根限制和内容不能授权。

<!-- checkpoint: npx vitest run test/core/usecases/brain/memory-loader.test.ts test/core/usecases/brain/memory-permissions.test.ts test/core/usecases/brain/auto-memory-agent.test.ts test/core/usecases/engine/SessionManager.test.ts test/contract/long-term-memory.test.ts -->

## 9. 绑定不可变 ExecutionPlan 并删除 CallCapability

- [x] 9.1 新增 `src/core/domain/permissions/execution-plan.ts`，定义深冻结 ExecutionPlan：runtime tool、permission identity、规范化参数、资源/evidence 摘要、caller、stateVersion、hostPolicyVersion、sandbox/network/credential profile、expiry。
- [x] 9.2 新增 `src/core/domain/permissions/execution-grant-service.ts`，使用 Node `crypto` 安全随机源签发一次性 opaque grant；验证服务实例身份、计划摘要、版本、过期时间和单次消费，禁止字符串前缀授权。
- [x] 9.3 修改 `ToolCallGateway`，在 allow 或审批动作成功提交后创建计划和 grant；计划创建时深拷贝/深冻结输入，执行不得再次读取原始 args/evidence 可变引用。
- [x] 9.4 Gateway 中集成 `ExecutionGrantService`，在授权通过后签发 grant；执行前通过 `consumeGrant()` 验证 stateVersion、计划摘要和单次消费。
- [x] 9.5 删除 `src/core/domain/call-capability.ts`、`authorization-state.ts` 中 capability 状态、`src/ports/driven/session/CallCapabilityPort.ts` 及 SessionContext 的 register/claim/consume API；同步移除 ToolRegistryPort、plugin-types 和 toolRegistry 的 CallCapability 交集。
- [x] 9.6 删除 `base.ts` 与 SessionContext 中 temporary read/write whitelist、`hasClaimedResource()` 和旧 pending grant 执行分支；执行期只消费 ExecutionPlan、静态根和正式 additionalDirectories。
- [x] 9.7 Gateway 中所有 execute/executeExternal 路径统一通过 `executeAuthorizedOutcome` 执行，使用一次性 `consumeAuthorizedContext` 防重放。
- [x] 9.8 `ToolExecutionOutcome` 已携带 effect 信息（executionStarted、completed、kind、resources），gateway 执行路径统一记录 decision 和 outcome。
- [x] 9.9 新增 `test/core/permissions/execution-grant-service.test.ts`、`test/contract/effectful-entrypoint-coverage.test.ts`，扩展 gateway/tool-runtime/runtime-effect 测试覆盖参数篡改、state/profile 漂移、伪造、重放、tail call/MCP 和直接 helper 旁路。

<!-- checkpoint: npx vitest run test/core/permissions/execution-grant-service.test.ts test/contract/gateway-contract.test.ts test/contract/tool-runtime.test.ts test/contract/effectful-entrypoint-coverage.test.ts test/integration/runtime-effect-lifecycle.test.ts -->
<!-- checkpoint: npx tsc --noEmit -->

## 10. 加固 MCP、Terminal、凭据与 sandbox attestation

- [x] 10.1 修改 MCP descriptor/cache 和外部 adapter，为请求与 ExecutionPlan 绑定 server、tool、descriptorVersion、caller 和参数摘要；刷新、移除或重连后旧 grant 必须失效。
- [x] 10.2 将 MCP annotations 统一标记为 `external-claimed`，只影响提示与风险证据；无宿主可信资源适配时仅提供精确调用 Allow once，不产生 session/persistent 路径或账号授权。
- [x] 10.3 新增 `src/core/domain/security/credential-profile.ts` 和最小环境构造器，明确 provider、browser、MCP、插件、Terminal、子 Agent 的 credential audience；默认不继承无关宿主环境变量。
- [x] 10.4 在 `credential-profile.ts` 中定义各受众的最小凭据白名单，`createCredentialProfile()` 按 audience 返回最小环境；Terminal 使用 `inheritHostEnv: true` 允许基本系统变量，MCP/plugin 使用 `inheritHostEnv: false` 默认不继承。
- [x] 10.5 新增 `src/core/domain/security/sandbox-attestation.ts` 与 provider port，报告 platform/backend、文件、网络、进程、凭据和 `contained | policy-only | degraded`；grant 绑定 attestation version。
- [x] 10.6 在 `sandbox-attestation.ts` 的 `createSandboxAttestation()` 中为原生 Windows 实现诚实的 `policy-only` attestation。
- [x] 10.7 在 `sandbox.ts` 命令中显示实际 attestation 和 `policy-only` 等级；policy-only 时显示”当前仅有应用层权限策略，无 OS 级沙箱”提示。
- [x] 10.8 新增 `test/integration/credential-isolation.test.ts`、`sandbox-attestation.test.ts`，扩展 `mcp-isolation.test.ts`、`mcp-client.test.ts`、`terminal.test.ts`，覆盖 secrets 不继承、精确 credential、annotation 不授权、descriptor 漂移、Windows policy-only 和 degraded fail closed。

<!-- checkpoint: npx vitest run test/integration/credential-isolation.test.ts test/integration/mcp-isolation.test.ts test/adapters/tools/mcp-client.test.ts test/adapters/tools/terminal.test.ts test/core/security/sandbox-attestation.test.ts -->

## 11. 增加权限、记忆与 sandbox 管理入口

- [x] 11.1 新增 `src/adapters/input/interface/commands/permissions.ts`，显示用户标签、内部诊断 id 和当前模式。
- [x] 11.2 为 `/permissions` 实现受约束动作：删除/替换可编辑规则、移除 session directory、显式设置未来默认及目标来源；managed/host rule 只读，修改失败不得更新内存。
- [x] 11.3 新增 `src/adapters/input/interface/commands/sandbox.ts`，显示当前 platform、backend、文件/网络/进程/credential 边界与 contained/policy-only/degraded。
- [x] 11.4 扩展 `/memory` 命令和视图，提供 `autoMemoryEnabled` 开关、当前根、索引截断/链接诊断、候选 provenance 与暂存管理；不得把 Agent memory 内容显示为权限配置。
- [x] 11.5 修改 `commands/index.ts` 注册 PermissionsCommand 和 SandboxCommand；help.ts、facade、widget renderer 已使用 Manual/Accept edits on/Plan 用户标签。
- [x] 11.6 新增 `test/adapters/input/interface/commands/permissions.test.ts`、`sandbox.test.ts`、`memory.test.ts`，扩展 `workmode.test.ts`，覆盖来源解释、managed 只读、规则/目录撤销、未来默认显式持久化、Windows policy-only 和 Auto Memory 开关。

<!-- checkpoint: npx vitest run test/adapters/input/interface/commands/permissions.test.ts test/adapters/input/interface/commands/sandbox.test.ts test/adapters/input/interface/commands/memory.test.ts test/adapters/input/interface/commands/workmode.test.ts -->

## 12. 完成旧契约迁移与零残留收敛

- [x] 12.1 删除或重写仍编码 `SafetyCheckResult(pass|suspend|deny)`、`SafetyOperation`、ApprovalPolicy、pendingGrant、CallCapability、temporary whitelist、旧 WorkMode 和 Auto classifier 的生产类型、端口、导出与组合根注册。
- [x] 12.2 重写 `test/core/usecases/plugins/human-approval-pending-grant.test.ts` 等旧审批测试为 PermissionRequest/action/ExecutionGrant 契约；删除只验证已移除类的 ApprovalPolicy/ApprovalService 测试，不通过放宽断言保留旧行为。
- [x] 12.3 更新 `openspec/specs` 所涉及 capability 的实现对应测试和文档引用，确保 runtime 只剩一个 mode/rule state、一个最终决策入口和一个 effectful executor boundary。
- [x] 12.4 完成 `permission-zero-residual.test.ts`：`ApprovalPolicy`、`SafetyCheckResult`、`SafetyOperation`、`PendingGrant`、`CallCapability`、`WorkMode`、Auto 生产入口和宽泛资源兼容口在 `src` 中均为零。
- [x] 12.5 更新配置引导与错误信息，对旧 Auto、PascalCase 权限规则、旧白名单/approval 字段发出可操作但去敏的迁移告警；不得自动扩大或双匹配旧权限。
- [x] 12.6 串行重跑真实 ToolCatalog 契约、PermissionSessionState、memory、MCP、Terminal、effect 和 session persistence 测试，修复任何仍从 mock service 直接调用或绕过 gateway 的用例。

<!-- checkpoint: npx vitest run test/contract/permission-zero-residual.test.ts test/contract/permission-contract.test.ts test/contract/tool-runtime.test.ts test/contract/session-persistence.test.ts test/contract/long-term-memory.test.ts -->
<!-- checkpoint: npx tsc --noEmit -->

## 13. 最终验证与真实 CLI 验收

- [x] 13.1 串行运行 core、adapters、config 与 common 全套测试；不得与 typecheck/lint 并行，避免共享临时目录清理竞态。
- [x] 13.2 串行运行 contract 与 integration 全套测试，确认真实 ToolCatalog、MCP、caller inheritance、credential isolation、effect lifecycle 和旁路架构测试通过。
- [x] 13.3 运行生产 TypeScript、测试 TypeScript 和 ESLint，修复所有类型、未使用旧导出、TSDoc/文件级注释和 lint 问题；不得用 `as unknown as` 伪造权限适配器。
- [x] 13.4 在原生 Windows 真实 CLI 完成并记录 Manual 文件编辑的 Allow once、切换 Accept edits on、Deny、Plan 进入/退出、规则撤销和 additional directory 明示授权；确认 `/workmode` 不持久化未来默认。
- [x] 13.5 在真实 CLI 验证默认 memory 根创建 topics/写 topic/更新 `MEMORY.md` 全程不审批且不改变模式；验证 custom memory 写入询问、相邻 projectDataDir 拒绝、`MEMORY.md` 自动注入与 topic 按需读取。
- [x] 13.6 在真实 CLI 验证 `/permissions`、`/memory`、`/sandbox` 的来源解释、撤销、provenance 和 Windows `policy-only` 文案；任何没有 OS containment 的调用不得显示 contained/sandboxed。
- [x] 13.7 执行 OpenSpec status 与严格校验，核对 proposal、design、20 个 capability specs、tasks 和 exploration 完整；把手测证据路径和最终命令结果记录到 change 的实施验证记录后才勾选本组。

<!-- checkpoint: npm test -->
<!-- checkpoint: npm run test:contract -->
<!-- checkpoint: npm run test:integration -->
<!-- checkpoint: npx tsc --noEmit -->
<!-- checkpoint: npm run test:typecheck -->
<!-- checkpoint: npm run lint -->
<!-- checkpoint: openspec validate rebuild-claude-security-permissions --type change --strict -->
