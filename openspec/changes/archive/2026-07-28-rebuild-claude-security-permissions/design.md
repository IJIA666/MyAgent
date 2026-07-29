## 背景

当前权限主链已经集中到 `ToolRegistry → ToolCallGateway → ToolPermissionService → ToolExecutor`，并使用服务签发、对象身份校验和单次消费的 `AuthorizedExecutionContext` 阻止直接执行器旁路。这些骨架应保留。

问题集中在主链两侧：

- 运行时工具使用 `writeFile`、`editFile`、`applyPatch`、`createDirectory` 等真实 camelCase 名称，权限服务却仍按 `Write`、`Edit`、`Create` 等假想名称判断模式和规则。
- `ToolPermissionCheckResult`、宽泛资源字典、通用 evidence、旧 `SafetyCheckResult`/`SafetyOperation`、规则建议和 `CallCapability` 同时存在，缺少唯一正式请求模型。
- `PermissionUpdate` 只能表达规则数组，无法原子表达 Claude 的 `setMode`、`addDirectories` 等动作。
- 当前 `/workmode` 同时修改会话状态和 `permission.defaultMode`，把临时模式误持久化为未来默认。
- `auto` 已进入类型、配置、CLI、模式管理和简化分类器，但没有足够的分类基线、保护规则和评测，属于公开的半实现能力。
- `initWorkspace()` 已把当前项目 memoryDir 作为执行期合法根，但文件工具的权限候选仍对该根返回 `ask`，造成同一轮记忆维护重复审批。
- `memory-loader.ts` 当前只读 20KB，并在会话启动时打开 topic 文件验证 frontmatter；Claude 的基线是只把 `MEMORY.md` 前 200 行或 25KB注入上下文，topic 文件由标准工具按需读取。
- 应用层路径与审批不是 OS sandbox。原生 Windows 当前没有可证明的完整文件、网络、进程和凭据 containment。

本设计以 Claude Code 官方权限/记忆行为和本地参考源码为权限产品基线；MyAgent 保留自身正确的执行网关、物理路径校验、Shell 分析和实际 effect 核算，并在其外侧增加不可绕过的宿主上限。

## 目标与非目标

**目标:**

- 所有本地、MCP、tail call 和内部有副作用调用都由同一会话权限状态和同一授权入口裁决。
- 真实工具名、真实参数与稳定权限身份之间存在受类型和覆盖测试约束的显式映射。
- 当前普通 UI 只呈现 `Manual`、`Accept edits on`、`Plan`，并实现 Claude 同构的进入、退出和审批后模式切换。
- 审批选项由工具权限适配器产生，可原子应用规则、模式和额外目录动作；“允许一次”绝不产生可复用授权。
- 默认 Auto Memory 根按 Claude 方式获得有界、明确的文件权限特例，且 `MEMORY.md` 继续自动注入。
- managed/user host cap、受保护资源、调用者信任和子 Agent 不扩权形成不可被项目或会话放宽的上限。
- 授权绑定不可变执行计划、权限状态版本、规范化资源和实际 sandbox profile，执行器只消费一次。
- 持久规则和未来默认模式使用原子/CAS 更新；失败时内存状态不变且副作用不开始。
- 用户可以查看权限规则、来源、额外目录、最近决策和实际 sandbox 状态。
- 自动测试从真实 ToolCatalog 发起真实工具调用，并建立零残留、旁路和凭据泄漏门槛。

**非目标:**

- 本 change 不交付 `Auto` 模式、Auto 分类器或其评测；以后必须通过独立设计重新引入。
- 本 change 不实现原生 Windows 完整 OS containment backend，也不把 Job Object、审批或路径正则宣传为完整沙箱。
- 本 change 不引入 Claude 专有 SDK，不复制私有源码，只实现可观察行为和本地等价边界。
- 本 change 不保留旧 `WorkMode`、`ApprovalPolicy`、`CallCapability` 或 PascalCase 规则的双轨长期兼容；无效旧配置只告警并忽略。
- 本 change 不允许项目内容、memory、MCP annotations 或子 Agent 修改 managed host policy、启用高级模式或扩大凭据范围。
- 本 change 不改变 Agentic 模型驱动循环为 workflow 状态机。

## 架构决策

### 1. Claude 行为是权限产品层的唯一基线

权限模式、规则优先级、工具专属候选、Plan 前态、审批后的模式迁移、额外目录和 Auto Memory 特例均以 Claude Code 的公开行为与本地源码夹具为基准。OpenClaw/Hermes 只用于补充 Claude 产品层之外的宿主硬上限和隔离原则，不引入第二套用户权限语义。

选择该方案而不是继续扩展当前通用 evidence 基线，是因为当前故障正是中央服务根据字符串和松散证据猜测工具语义；Claude 已证明由工具拥有参数解释和审批候选、中央上下文拥有最终状态的分工可用。

### 2. 每个会话只有一个 `PermissionSessionState`

新增会话级状态对象，至少包含：

- `mode` 与 `prePlanMode`
- 已解析的分层规则视图和 session rules
- `additionalDirectories`
- 单调递增的 `stateVersion`
- 有界的模式迁移历史

`SessionContext` 创建并拥有该对象；`ToolRegistry`、`ToolCallGateway`、`ToolPermissionService`、审批适配器和 CLI 只引用同一实例，不再各自缓存模式或规则。`permission.defaultMode` 仅在新会话创建时读取；普通 `/workmode` 和审批产生的 `setMode(..., session)` 不写设置。

当前生产模式集合为内部 id `default`、`acceptEdits`、`plan`、`dontAsk`、`bypassPermissions`。普通 UI 只映射前三项为 `Manual`、`Accept edits on`、`Plan`。高级模式只能由受信启动参数或高级管理入口进入，项目/local settings、模型和子 Agent 不能启用 `bypassPermissions`。

### 3. ToolCatalog 注册有类型的权限适配器

`NativeTool`/外部 descriptor 增加正式权限描述，包含：

- 运行时工具名
- 稳定权限身份
- 输入解析与规范化函数
- 操作类别和 Edit 分类
- 正式资源证据构造器
- 工具专属审批动作构造器

文件工具采用显式映射：`readFile → Read`、`writeFile → Write`、`editFile/applyPatch → Edit`、`createDirectory → Write`；`deletePath`、`movePath`、`copyPath` 保持独立的高风险操作，不因 `acceptEdits` 自动归入普通编辑。`execute_command` 根据已选 shell family 映射为 Bash 或 PowerShell，并继续复用现有专属命令分析。

中央服务不得再用 `Set(['Write', 'Edit', ...])` 或 `args.path ?? args.filePath` 猜测真实工具。effectful 工具缺失适配器时 fail closed；纯读工具缺失适配器也只能使用显式登记的只读身份，不按名称猜测。

### 4. 资源证据改为穷尽判别联合

删除 `Readonly<Record<string, unknown>>` 兼容口。正式证据联合至少覆盖文件、目录范围、命令子操作、URL/网络端点、外部账号副作用、MCP 调用和未知资源，并统一携带：

- 原始表达式与规范化结果
- 操作和访问范围
- 物理文件身份或网络分类
- source node/分析器
- 敏感度与 protected 标记
- caller/channel trust 与数据 provenance
- `host-verified`、`tool-analyzed`、`external-claimed` 等可信度

文件证据在授权前完成真实路径、symlink/junction 和 Windows 大小写规范化。MCP 自声明只能形成 `external-claimed` 证据，不能独立产生 allow。

### 5. 权限流水线采用固定分层与 stricter-wins

单次调用按以下顺序处理：

1. 验证 `TrustedCallContext`、工具注册和输入契约。
2. 工具适配器生成规范化请求、资源证据和候选审批动作。
3. managed/user host cap 与 protected-resource policy 应用不可绕过 deny/ask。
4. 显式规则按 `deny → ask → allow` 匹配。
5. 应用 Claude 内建基线，包括默认 memory 根特例。
6. 由当前 mode 对可覆盖候选做最终收紧或放行。
7. `ask` 交给可信 UI；UI 只返回已展示动作的 id。
8. 会话/持久更新原子提交后，创建不可变执行计划和一次性 grant。
9. 统一执行器使用计划快照执行并报告实际 effect。

高层 hard deny、显式 deny 和输入完整性错误先于 memory allow。`bypassPermissions` 只能跳过可自由裁量的普通 ask，不能覆盖 host cap、受保护资源、调用者验证、凭据隔离和实际 sandbox 上限。

### 6. `PermissionUpdate` 是动作判别联合

以动作联合替换当前“operation + rules[]”弱结构，至少包含：

- `addRules`、`replaceRules`、`removeRules`
- `setMode`
- `addDirectories`、`removeDirectories`

一个审批选项可以携带多个动作，并指定 `session`、`projectLocal`、`project` 或 `user` 目标。managed/host 来源只读。动作先整体验证，再以单次状态事务应用；其中任一动作失败时全部不生效。

工作区内普通文件编辑的默认选项为：

1. Allow once
2. Allow and turn on Accept edits for this session
3. Deny

第二项只执行 `setMode(acceptEdits, session)`。范围外目录仍使用同一文件审批组件，但只有用户明确选择时才组合 `addDirectories(canonicalDir, session)` 与 `setMode(acceptEdits, session)`；Allow once 不添加目录也不改变模式。

### 7. Auto Memory 按 Claude 方式有界耦合

记忆子系统与主 Agent 工具权限使用 Claude 的三条路径：

- 会话启动：`SessionManager.open()` 在 `autoMemoryEnabled` 时只对 `MEMORY.md` 执行前 200 行或 25KB 的有界宿主读取，作为低权限 context 注入；不进入工具审批。
- 主 Agent 工具：文件权限层使用 `isAutoMemPath()`/`isAgentMemoryPath()` 等价判断。默认根的 Read/Edit/Write 及 MyAgent 映射为 Write 的 `createDirectory` 在显式 deny 之后、危险目录与普通 ask 之前 allow。
- 后台记忆 Agent：独立 `createAutoMemCanUseTool(memoryDir)` 只允许 Read/Grep/Glob、只读 Bash，以及 memory 根内的 Edit/Write，其他工具拒绝。

自定义 `autoMemoryDirectory` 必须是可信 settings 来源提供的规范化绝对路径；项目/local 来源需要工作区信任。它的读取允许，写入不继承默认根特例，除非存在显式 allow rule。topic 文件不在会话启动时打开或注入，由标准文件工具按需读取；显式 `/memory` 诊断可以独立扫描 topic 元数据。

路径操作 allow 不提升内容权重。memory 不得承载权限规则、系统策略或 caller identity；外部不可信渠道形成的候选记忆进入带 provenance 的暂存区。

### 8. protected-resource policy 位于所有执行通道之前

不可绕过策略统一覆盖：

- `.git/`、`.myagent/settings*.json`、`.myagent/rules/`、hooks、启动配置、IDE 自动执行配置
- `.env`、凭据、模型 provider secrets、浏览器认证材料、MCP server secrets
- 工作区根、用户目录根、磁盘根及当前会话之外的项目数据
- cloud metadata、loopback 管理接口、link-local、私网 SSRF 范围
- 外部账号发送、发布、删除、付款和权限变更

项目/local/session/tool 层只能收紧，不能放宽 managed/user host cap。子 Agent 继承父级最终有效策略快照和工具面；未验证的远程 caller/channel 不得复用本地交互用户的授权。

### 9. 授权绑定不可变执行计划

`AuthorizedExecutionContext` 升级为服务签发的一次性 grant，引用深冻结的 `ExecutionPlan`。计划至少绑定：

- runtime tool 与稳定权限身份
- 规范化、深冻结的参数
- 资源身份与 evidence 摘要
- caller/channel identity
- permission `stateVersion` 与 host policy version
- sandbox、network、credential profile
- 过期时间与使用加密安全随机源生成的一次性 nonce

执行器只使用计划中的参数。计划内容、权限状态、host policy 或 sandbox profile 发生变化时，grant 失效并重新授权。对象身份和单次消费继续保留，禁止只检查 `auth_` 字符串前缀。

所有本地工具、MCP、tail call 和内部 effectful helper 通过同一执行入口。架构测试维护 effectful entrypoint 清单并扫描新增旁路。

### 10. 持久化先落盘、会话状态后提交

`PermissionSettingsStore`/`SettingsRepository` 为规则和未来默认模式提供带版本或摘要的 CAS 更新、临时文件写入和原子替换。持久更新必须等待成功后才更新会话内存并签发执行 grant；冲突、磁盘失败或目标来源不可写时不执行副作用。

现有旧 PascalCase 规则、`auto` 默认模式和旧 approval/capability 字段不做双轨匹配。加载器记录不含敏感原文的迁移告警并忽略无效值；用户可通过 `/permissions` 建立新规则。

### 11. sandbox 状态必须反映事实

定义 `SandboxAttestation`，至少报告文件、网络、进程、凭据和平台边界，以及：

- `contained`：存在可验证的 OS containment backend。
- `policy-only`：只有应用层权限/路径策略，没有 OS containment。
- `degraded`：配置要求的边界未能建立或状态不可确认。

原生 Windows 在本 change 中默认报告 `policy-only`。Terminal、MCP、插件和子 Agent 启动时使用显式最小环境，不继承无关宿主 secrets；高风险任意代码审批必须展示无 OS containment 的宿主级风险。

真实 WSL2/container/Restricted Token backend 留待独立实现，但未来 backend 必须通过相同 attestation 和 profile 契约接入，不能仅凭配置声明 `contained`。

### 12. 管理与可观测性

新增 `/permissions` 展示用户标签、内部模式诊断值、有效规则、来源文件、被 host cap 压制的规则、额外目录和最近决策链，并支持受约束的规则/目录删除与未来默认模式设置。

`/memory` 继续负责 Auto Memory 开关、索引诊断和候选记忆；`/sandbox` 展示 attestation。审批与审计记录实际工具、权限身份、规范化资源、caller、选定动作、落盘结果、grant 与 sandbox profile，不记录凭据正文。

## 风险与权衡

- [memory 根内建 allow 扩大静默写入] -> 仅允许已校验的精确默认根和明确维护操作；显式 deny/hard cap 优先，删除、移动、执行、settings 和相邻目录不继承。
- [Accept edits on 修通后更容易修改受保护文件] -> protected-resource policy 必须先于模式生效，并用真实路径与工具适配覆盖测试约束。
- [一次性替换旧权限契约导致测试和设置大面积失效] -> 新项目不保留双轨运行；在迁移阶段先建立行为夹具，再重写旧测试和输出明确配置告警。
- [大规模 change 容易产生新的旁路] -> 按依赖 checkpoint 实施，每阶段运行类型检查与聚焦测试；最终使用 effectful entrypoint 清单和零残留扫描。
- [持久化 CAS 增加实现复杂度] -> 复用 `SettingsRepository` 作为唯一文件写边界；宁可更新失败并拒绝执行，也不接受内存成功、磁盘失败的假持久化。
- [MCP/外部工具缺少可信资源解析] -> 保守限制为精确调用的一次性授权；annotations 只影响提示和风险证据。
- [原生 Windows 无完整 containment] -> 状态页、审批和审计显示 `policy-only`，不使用“sandboxed”措辞；凭据最小化和统一执行入口作为立即边界。
- [后台记忆 Agent 可读取过多上下文] -> 保持与 Claude 相同的工具面，但使用独立 caller、审计标签和写入根限制；host cap 仍不可绕过。

## 迁移计划

1. 建立 Claude 行为夹具、真实 ToolCatalog 工具清单、effectful entrypoint 清单和当前失败基线。
2. 从生产类型、配置、CLI、帮助和模式管理删除 `auto` 与简化分类器；对旧配置告警并回退 `default`。
3. 引入单一 `PermissionSessionState`、正式工具权限适配和资源证据联合；迁移真实 camelCase 工具及 Shell/MCP。
4. 将 `PermissionUpdate` 迁移为动作联合，接通文件编辑模式切换、额外目录和原子持久化；删除旧审批、capability 和临时白名单状态机。
5. 复刻 Auto Memory 三条路径，调整 `MEMORY.md` 为 200 行/25KB，仅按需读取 topic，并加入后台记忆 Agent 边界。
6. 接入 protected-resource policy、caller trust、不可变 `ExecutionPlan`/grant、credential profile 和 sandbox attestation。
7. 增加 `/permissions`、`/memory`、`/sandbox` 管理与解释界面，完成真实 CLI 手测。
8. 重写旧契约测试并依次运行聚焦测试、全量测试、TypeScript、ESLint、OpenSpec 严格校验和零残留扫描。

回滚不恢复双轨旧运行时。若某阶段未通过 checkpoint，则回退该阶段代码和 settings schema 版本，保留上一个可用 checkpoint；已写入的新格式设置通过原子文件备份恢复。任何无法验证的授权状态按失效处理并要求重新决策。

## 待确认问题

本 change 没有阻塞实施的设计问题。`Auto` 分类器路线与真实 OS containment backend 已明确排除，必须在各自具备独立调研、威胁模型和评测后再提出新 change。
