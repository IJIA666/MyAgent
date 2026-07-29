## Why

当前项目虽然已经具备统一 `ToolCallGateway`、`ToolPermissionService`、一次性授权上下文和物理路径校验，但真实产品行为仍与 Claude Code 权限语义错位：原生 camelCase 文件工具没有稳定的权限身份映射，`acceptEdits` 无法覆盖实际编辑工具，默认模式维护项目长期记忆会反复审批，审批更新只能增加规则而不能表达模式或目录动作，当前会话切换还会隐式改写未来默认配置。

与此同时，旧 `ApprovalPolicy`、`CallCapability`、宽泛资源字典、半实现的 `auto` 分类器及历史 specs 仍保留平行语义，造成“测试通过但真实调用链错误”。继续修补旧契约会把这些冲突固化为长期包袱。

本变更以 Claude Code 的现行权限行为和本地参考源码为唯一权限产品基线，替换错误抽象并建立可验证的宿主安全上限。当前阶段不交付尚未完成设计与评测的 `Auto` 模式，也不把应用层权限冒充为原生 Windows OS 沙箱。

## What Changes

- **BREAKING**：以单一会话权限状态替换分散的模式、规则、临时目录和旧授权状态；会话模式切换不再隐式持久化为未来默认值。
- **BREAKING**：当前生产 `PermissionMode` 移除未完成的 `auto`，普通界面只显示 `Manual`、`Accept edits on`、`Plan`；`dontAsk` 与 `bypassPermissions` 仅保留受信高级入口。
- **BREAKING**：删除旧 `ApprovalPolicy`、`SafetyCheckResult`/`SafetyOperation` 兼容语义、`CallCapability` 状态机及依赖旧 `suspend`/`pendingGrant` 的并行审批路径。
- 为每个有副作用的真实 ToolCatalog 工具建立受类型约束的权限适配，显式映射运行时工具名、真实参数、稳定权限身份、资源证据和工具专属审批动作；缺失适配器时保守拒绝或询问。
- 将 `PermissionUpdate` 改为可穷尽表达规则增删改、会话模式切换和额外目录增删的判别联合；文件编辑审批提供“允许一次”“本会话开启 Accept edits on”“拒绝”。
- 保留 `deny → ask → allow`、`prePlanMode`、统一网关和一次性消费，补充 managed/user host cap、受保护资源和 stricter-wins 合成。
- 复刻 Claude Code Auto Memory 边界：`MEMORY.md` 在会话启动时有界自动注入；文件权限层明确识别默认 memory 根并放行维护性读写；自定义根和后台记忆 Agent 按 Claude 的独立规则处理。
- 将授权绑定到深冻结的执行计划、规范化资源、权限状态版本和实际 sandbox/credential/network profile；持久更新必须先原子成功落盘再执行副作用。
- 增加 `/permissions` 管理入口和可验证的 sandbox 状态展示，明确区分 `contained`、`policy-only`、`degraded`。
- MCP、Terminal、任意代码、插件和子 Agent 继承宿主硬上限，不得依靠自声明元数据、项目配置或子级模式扩大权限。
- 建立 Claude 行为夹具、真实 ToolCatalog 契约测试、旁路架构测试、凭据泄漏测试和真实 CLI 手测门槛；严格执行旧类型与旧路径的零残留检查。

## 业务能力

### 新增业务能力

- `protected-resource-policy`: 定义 managed/user host cap、受保护文件与网络资源、调用者信任和 stricter-wins 的不可绕过策略。
- `permission-management`: 提供 `/permissions` 查看、解释、修改规则与会话额外目录的可信管理入口。
- `sandbox-status`: 如实报告当前执行 backend、文件/网络/进程/凭据边界及 `contained`、`policy-only`、`degraded` 状态。

### 修改业务能力

- `permission-model`: 收敛当前模式集合，建立单一会话权限状态、工具专属审批动作、模式/规则/目录更新及 Claude 行为基准。
- `security-modes`: 修改普通模式展示、会话切换、未来默认持久化和高级模式入口语义。
- `tool-catalog`: 要求所有有副作用的本地与外部工具显式注册权限适配，不允许中央服务按运行时字符串猜测。
- `tool-policy-port`: 以 Claude 风格工具权限检查和正式资源证据替换遗留安全结果与平行决策契约。
- `tool-access-metadata`: 将宽泛资源字典替换为穷尽、可验证、带 provenance 的资源证据联合。
- `file-edit`: 让真实 `writeFile`、`editFile`、`applyPatch`、`createDirectory` 等工具正确响应 Manual 与 Accept edits on，并保留受保护路径。
- `directory-scope-authorization`: 将额外目录改为显式 `PermissionUpdate` 动作，保持物理路径边界且不由单次批准隐式扩大。
- `markdown-first-long-term-memory`: 保留自动注入，并增加 Claude 同构的默认 memory 根读写特例、自定义根规则和后台记忆 Agent 边界。
- `human-approval`: 收敛为只处理最终 `ask` 的可信交互，渲染工具提供的动作集合，不再拥有独立授权状态机。
- `approval-policy-contract`: 删除旧中央审批策略、资源兼容和 capability 映射，迁移到单一权限决策及判别联合更新。
- `cli-workmode-command`: 普通 UI 改为 `Manual / Accept edits on / Plan`，移除 Auto 生产入口并停止隐式持久化。
- `config-management`: 增加权限规则与未来默认模式的分层来源、原子/CAS 更新及旧配置拒绝或告警语义。
- `external-tool-policy-adapter`: 将 MCP annotations 降为不可信证据，绑定调用者身份并限制可复用授权范围。
- `tool-executor`: 使用不可变执行计划和一次性 grant，禁止所有本地、MCP、tail call 与内部有副作用 helper 绕过统一授权入口。
- `runtime-effect-accounting`: 将实际 effect 与已批准计划、执行开始状态及 sandbox attestation 一起沿统一链路传递。
- `terminal-tool`: 收紧任意代码、环境变量、网络与凭据 profile，并在没有 OS containment 时明确提示宿主级风险。
- `base-security`: 保留物理路径和 symlink/junction 防护，加入精确 memory 根、受保护根和宿主 hard cap 的执行期复核。

## 影响范围

- 权限领域：`src/core/domain/permissions/*`、会话上下文、模式管理、规则存储和权限更新类型。
- 工具运行时：`src/adapters/tools/ToolCallGateway.ts`、`ToolExecutor.ts`、`ToolCatalog.ts`、`toolRegistry.ts`、`tool-types.ts` 及所有有副作用工具。
- 文件与记忆：`src/adapters/tools/impl/base.ts`、文件系统工具、`memory-loader.ts`、`session.ts`、`model-request-assembler.ts` 和应用路径配置。
- CLI 与交互：`workmode.ts`、新增 permissions/sandbox 管理命令、审批 facade、帮助和状态渲染。
- 配置与持久化：`src/config/*`、`PermissionSettingsStore.ts`、`terminal-config.ts` 及 settings schema。
- 外部边界：MCP adapter、Terminal/脚本执行、插件、子 Agent、caller/channel 上下文和 credential/network profile。
- 测试：权限单元测试、真实 ToolCatalog 契约测试、CLI 交互测试、记忆契约、MCP、执行 grant、架构旁路、凭据泄漏与平台状态测试。
- 不引入 Claude 专有 SDK；不交付 `Auto` 分类器或原生 Windows 完整 OS containment backend。
