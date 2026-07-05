# 探索主题: 目录层级审批范围与重复授权

## 1. 问题定义
当前文件系统审批存在一个明显的交互语义问题：当智能体访问具有层级关系的目录时，例如先访问 `a`，再访问 `a/b`，再访问 `a/b/c`，系统可能连续发起多次审批。用户认为这与“本会话始终放行”这类选项的直觉语义不一致。本次探索的目标是澄清三个问题：

1. 当前仓库为什么会出现这种逐层重复审批。
2. 这种行为在产品语义上是否合理。
3. 主流 agent 对目录层级授权通常采用什么做法。

## 2. 关键发现与调研结果
- **代码库现状**：本仓库当前的 session 级路径授权是“精确路径授权”，不是“目录子树授权”。
  - `ListFilesTool.checkSafety()` 在越界时只上报当前目标目录这一条读资源，`resources` 仅包含单个 `normalizedPath`，见 `src/adapters/tools/impl/filesystem/file-system.ts`。
  - `ApprovalPolicy.mapChoiceToEffect()` 在用户选择 `session` 后，仅将这些原始 path 资源直接转成 pending grant，不做目录范围扩展，见 `src/core/usecases/security/ApprovalPolicy.ts`。
  - `agent-loop.ts` 提交 `session` grant 时，仅把 `normalizedPath` 原样写入临时白名单，见 `src/core/usecases/engine/agent-loop.ts`。
  - `SecurityService.hasTemporaryReadWhitelist()` 和 `hasTemporaryWriteWhitelist()` 使用 `Set.has(resolve(pathStr))` 做精确匹配，不支持父目录覆盖子目录，见 `src/core/usecases/security/SecurityService.ts`。
  - `secureResolveReadPath()` / `secureResolveWritePath()` 在白名单判定时同样只检查当前解析结果是否精确命中，不做前缀或子树判断，见 `src/adapters/tools/impl/base.ts`。
- **日志证据**：本地 trace 已经复现出明显的逐层下钻行为：`C:\` → `C:\Users` → `C:\Users\15229` → `C:\Users\15229\AppData` → `C:\Users\15229\AppData\Local`。这说明重复审批不是单次偶发，而是当前模型与权限实现共同作用下的稳定结果。
- **核实与洞察**：
  - Claude Code 文档显示，`acceptEdits` 对工作目录与 `additionalDirectories` 内路径直接放行，外部路径按作用域控制，而不是每深入一层目录再重新审批。这说明 Claude 至少在工作区与附加目录边界上采用了“父目录覆盖子路径”的范围模型。
  - OpenCode 文档显示，`external_directory` 支持 `~/projects/personal/**` 这类通配范围；审批里的 `always` 也是批准未来匹配该模式的请求。这是最直接、最可类比的目录子树或模式级授权证据。
  - Gemini CLI 文档显示，可信目录采用“信任父目录即信任其子目录”的模型；沙箱扩展也是按目录整体纳入，而不是逐层单点授权。这是另一个强辅助证据。
  - 因此，在直接可比的样本中，主流做法明显更偏向“范围授权”或“模式授权”，而不是“精确路径逐层审批”。
- **源码级竞品调研**（基于 `D:\projects\Agents` 下 5 个开源项目的源码深度分析）：
  - **Claude Code**：核心机制位于 `filesystem.ts` 的 `pathInWorkingPath()` 函数，通过跨平台相对路径计算检测子目录关系。`allWorkingDirectories()` 将原始 cwd 与 `additionalWorkingDirectories` 合并为集合，任何在此集合下的路径自动放行。更精细的规则使用 **gitignore 风格模式匹配**（`ignore().add(patterns)` 库），支持 `//path`（文件系统根相对于）、`/path`（设置文件目录相对于）、`~/path`（用户主目录相对于）、`./path`（工作目录相对于）四种前缀语义。`additionalDirectories` 在 `initializeToolPermissionContext()` 中通过 `settings.permissions.additionalDirectories` 配置加载，经 `validateDirectoryForWorkspace()` 验证后加入 Map，运行时由 `allWorkingDirectories()` 使用。需要注意的是，这里更偏“工作区/信任范围建模”，不是单独针对一次审批回写语义的直接证据。
  - **OpenCode**：基于 `(action, resource, effect)` 三元组规则的权限评估引擎。`LocationMutation.resolve()` 是核心路径安全机制，检测三种逃逸模式：`relative_escape`（`..` 攻击）、`location_escape`（符号链接导致解析位置根目录外）、`non_directory_ancestor`。当路径解析到 Location 外部时，设置 `externalDirectory` 属性，触发额外的 `”external_directory”` 权限检查，其资源格式为 `”<directory>/*”`——这是显式的 **目录子树通配模式**。`FSUtil.contains()` 通过 `relative(parent, child)` 计算并检查结果不在 `..` 前缀内。已保存权限通过 SQL 数据库的 `PermissionSaved.Service` 持久化，跨会话生效。E2E 测试见 `external-directory.test.ts`。
  - **Hermes Agent**：全局级 `tools/approval.py`（~2220 行）实现完整审批系统。`_session_approved: dict[str, set]` 管理按会话的审批状态，用户可选择 “once” / “session” / “always”。不过它的 session/always 主要是按 `pattern_key` 复用审批结果，而 `build_write_denied_prefixes()`、`_check_sensitive_path()` 更偏文件安全边界与拒绝链设计。它能证明 Hermes 使用“前缀/范围”思维来建模安全边界，但不能单独证明“目录浏览审批”一定采用子树授权。
  - **OpenClaw**：`wrapToolWorkspaceRootGuardWithOptions()` 与 `assertSandboxPathWithinAnyRoot()` 说明其文件工具存在明确的根目录守卫；`ToolFsPolicy.workspaceOnly` 说明其可以强制约束文件操作只能在工作区内；`exec-approvals.ts` 则更多聚焦命令审批与持久化命令白名单。这些证据可以证明 OpenClaw 很重视“根范围”和“模式匹配”，但它并不是“目录浏览审批范围”的同层直接样本。

  - **Gemini CLI**：最具有参考价值。文件 `trust.ts` 定义了三层信任模型：`TrustLevel.TRUST_FOLDER`（信任此目录及其所有子目录）、`TRUST_PARENT`（信任父目录，即该目录是子路径时继承父目录信任）、`DO_NOT_TRUST`（显式不信任）。`LoadedTrustedFolders.isPathTrusted()`（第 150-190 行）使用 `isSubpath()` 进行层次路径关系匹配，总是选择匹配路径最长（最具体）的规则，`DO_NOT_TRUST` 优先覆盖其他信任级别。信任决策参考三个来源：环境变量 `GEMINI_CLI_TRUST_WORKSPACE`、IDE 信任状态、以及 `~/.gemini/trustedFolders.json` 配置文件。所有文件操作工具统一调用 `config.ts` 中的 `validatePathAccess()` 作为入口。沙箱系统中通过 `sandboxPolicyManager` 支持 per-command 的会话和持久化权限批准。

  - **对比总结**：直接可比的强证据主要来自 `OpenCode` 与 `Gemini CLI`，两者都明确采用“父目录或目录模式覆盖子路径”的授权模型；`Claude Code` 则在工作目录与附加目录层面采用同样的范围边界思路。`Hermes` 与 `OpenClaw` 更适合作为“范围匹配、安全根边界、拒绝优先”设计参考，而不是直接证明目录审批一定采用子树授权。综合来看，更稳妥的结论是：主流设计明显偏向范围模型，而不是 `a -> a/b -> a/b/c` 这种逐层单点重复审批模型。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 A：保持精确路径授权 | 方案 B：对目录浏览引入子树授权 | 结论 |
| :--- | :--- | :--- | :--- |
| 实现复杂度 | 低，几乎不改模型 | 中，需要区分文件与目录资源语义 | A 占优 |
| 用户认知一致性 | 弱，”会话始终放行”容易被理解错 | 强，符合目录浏览的直觉 | B 占优 |
| 审批打断频率 | 高，层级越深越频繁 | 低，同一目录树内一次放行即可 | B 占优 |
| 安全边界清晰度 | 表面清晰，但语义碎片化 | 取决于范围建模是否严格 | 平手 |
| 与主流产品一致性 | 弱 | 强（OpenCode `external_directory/*` 与 Gemini CLI `isPathTrusted()`+`isSubpath()` 提供了最直接的范围授权证据，Claude Code 的工作目录边界也提供了辅助支持） | B 占优 |
| 写权限误放大风险 | 低 | 中，若直接复用到写权限会变危险 | A 占优 |

**推荐路径**：采用“读目录浏览使用子树授权，写权限继续保持保守”的混合方案。

推荐细化为以下规则：
- `once`：仅放行当前这一次调用，不做会话复用，也不自动升格成目录范围授权。
- 对目录浏览类读操作的 `session/always`：例如 `listFiles`、目录型 `glob`、目录型 `grep`，批准后发放“目录子树级只读授权”。
- 对单文件读取类读操作的 `session/always`：例如 `readFile`，仍保留精确路径授权，不自动升格成同目录或父目录授权。
- 对 `listFiles`、目录型 `glob`、目录型 `grep` 这类“浏览目录树”的读操作，引入目录子树级 session grant。
- 对 `readFile` 这类明确面向单文件的读取，仍可保持精确路径授权。
- 对所有写操作，不建议直接继承目录子树语义，避免把一次目录查看放大成目录内任意写。
- 资源模型建议显式区分两类读资源，而不是继续复用同一种 path 资源：
  - `kind: 'path'`：精确文件或精确节点授权。
  - `kind: 'directory-scope'`：目录及其子路径授权，仅限 `access: 'read'`。
- 审批文案必须同步升级为显式范围描述，例如“允许读取 `C:\Users\15229` 及其子目录（本会话）”，不能再用模糊的“始终放行”掩盖实际是单点路径授权。

## 4. 约束、风险与未知项
- 当前 `SafetyResource` 只有 path 资源，没有显式”目录子树”资源类型。如果直接改成前缀匹配，容易把文件授权、目录授权、读授权、写授权混在一起。
- Windows 下路径大小写、符号链接、junction、真实物理路径归一化都必须继续依赖现有 `getPhysicalRealPath()` 和安全解析器，不能简单做字符串前缀比较。Claude Code 的 `pathInAllowedWorkingPath()` 做法值得参考：同时检查原始路径和符号链接解析后路径。
- 若未来引入目录子树授权，必须明确只对目录型资源生效，不能让 `readFile(a.txt)` 自动扩大成 `a.txt` 同级目录甚至父目录授权。OpenCode 的做法是区分 `”read”`（基于 file path 的精确资源）和 `”external_directory”`（基于 `directory/*` 通配模式的目录范围资源），两者是独立的权限动作。这一点对本仓库尤其重要，因为本仓库当前的 `secureResolveReadPath()` / `secureResolveWritePath()` 共享底层路径解析器，若不拆资源语义，很容易互相污染。
- 需要补充一个语义边界：用户选择 `once` 时，仍应允许仅放行单次当前目录访问；真正不合理的是 `session/always` 仍然单点授权。Gemini CLI 的 TrustLevel 体系给出了一种可借鉴的分级思路：`TRUST_FOLDER`（信任该目录及所有子目录）与 `TRUST_PARENT`（信任父目录）用不同信任级别区分场景，但本仓库不必照搬其完整模型。
- 还需要在交互层确认审批 UI 是否支持把”本次批准实际覆盖的范围”清晰展示给用户，否则语义改了但可见性不够。Claude Code 的 `generateSuggestions()` 在生成建议时默认使用 `destination: 'session'`，且 `.claude/**` 下的 allow 规则被限制为仅匹配 session 来源防止误授权，这种做法可参考。

## 5. 否决方案
- **否决方案一：保持当前实现不变，只修改提示文案**。这只能降低误解，不能解决深层目录浏览时的审批噪音，且会继续削弱“会话始终放行”的实际价值。
- **否决方案二：所有 path 资源统一改成前缀匹配**。这会把单文件授权与目录授权混为一谈，极易导致权限放大，尤其会污染写路径安全模型。更合理的做法是像 OpenCode 那样，显式区分“精确资源”和“目录范围资源”。
- **否决方案三：读写统一继承目录子树语义**。这在安全上过于激进，不符合当前仓库一贯的读写隔离设计。即便参考 Gemini CLI，也应该只借鉴其“范围边界”的建模思路，而不是把写权限直接扩成目录范围。
