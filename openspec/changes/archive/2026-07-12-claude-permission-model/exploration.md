# 探索主题: Claude Code 权限行为基线的同构实现

## 1. 问题定义

当前 MyAgent 的权限模型将 `WorkMode`、工具安全检查、Plan 特判、审批插件、审批策略、capability、MCP 适配和执行器兜底逻辑分散在多个边界中。继续局部修补会继续产生重复决策和模式分支。

本次方向收敛为：**以 Claude Code 权限行为作为唯一基线，进行同构实现。** 这不是机械复制 Claude Code 的源码目录、私有基础设施或偶然命名，而是完整保持其权限原语、模式语义、规则语法、决策顺序、模式转换和审批复用行为。MyAgent 只替换平台适配部分，包括 OpenAI 消息协议、现有工具注册、终端交互和执行器。

本次暂不吸收 OpenCode、OpenClaw、Hermes 或其他方案的权限抽象，避免再次形成混合模型。

## 2. 关键发现与调研结果

### 2.1 当前 MyAgent 的问题

- `src/config/types.ts`、`src/adapters/tools/impl/system/terminal-config.ts`、`src/core/domain/context.ts` 共同维护 `WorkMode = Safe | Auto | YOLO | Plan`。
- `terminal.ts`、`file-system.ts` 等工具直接读取 `WorkMode`，在工具内部做最终安全判断。
- `HumanApprovalPlugin` 根据 `Plan + planSideEffect` 再次判断。
- `ApprovalPolicy` 根据模式再次过滤审批结果。
- `model-request-assembler.ts` 通过提示词和工具裁剪影响 Plan 行为，形成了非执行层的安全假设。
- `ToolExecutor` 仍有高危兜底审批，导致执行器出现第二套权限流程。
- `SafetyCheckResult` 同时承载分析结果和最终决策，`PlanSideEffect` 同时承载效果、风险和未知状态。
- capability 被设计成审批后的执行票据，但 Claude Code 的直接模型使用规则更新和 session 规则管理，不把 capability 作为核心权限原语。

### 2.2 Claude Code 的固定权限行为契约

本地参考源码：

- `D:\projects\Agents\claude-code-analysis\src\types\permissions.ts`
- `D:\projects\Agents\claude-code-analysis\src\utils\permissions\PermissionRule.ts`
- `D:\projects\Agents\claude-code-analysis\src\utils\permissions\PermissionMode.ts`
- `D:\projects\Agents\claude-code-analysis\src\utils\permissions\permissions.ts`
- `D:\projects\Agents\claude-code-analysis\src\utils\permissions\permissionSetup.ts`

以下内容是同构实现必须保持的固定契约，不再自行设计：

```ts
type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'auto'
  | 'dontAsk'
  | 'bypassPermissions';

type PermissionBehavior = 'allow' | 'deny' | 'ask';

type PermissionRule = {
  source: PermissionRuleSource;
  ruleBehavior: PermissionBehavior;
  ruleValue: {
    toolName: string;
    ruleContent?: string;
  };
};
```

Claude Code 的工具权限结果还包括内部 `passthrough`：工具没有做出最终判断时，将决策交给统一权限流程继续处理。这个状态不能与最终的 `allow / ask / deny` 混为一谈。

同构实现不要求 MyAgent 使用 Claude Code 完全相同的文件、函数或类名。允许使用下列本地组织方式：

```text
PermissionModeManager
PermissionRuleStore
ToolPermissionService
PermissionPromptAdapter
AutoPermissionClassifier
```

这些名称只是实现组织，不得改变上述契约的语义或执行顺序。

权限决定保留 Claude Code 的结构化结果：

- `allow`：允许执行，可携带 `updatedInput` 和 `decisionReason`；
- `ask`：需要用户确认，可携带提示信息、规则更新建议和分类器待检查信息；
- `deny`：拒绝执行，必须携带拒绝原因；
- `passthrough`：仅作为工具内部检查结果，不是最终执行决策。

### 2.3 Claude Code 的规则语义

规则采用 `Tool` 或 `Tool(specifier)` 形式：

- `Bash`：匹配工具的所有调用；
- `Bash(npm run *)`：匹配命令内容；
- `Read(./.env)`：匹配文件资源；
- `mcp__server`：匹配 MCP 服务；
- `mcp__server__tool`：匹配具体 MCP 工具；
- `Agent(Explore)`：匹配特定子代理。

规则来源沿用 Claude Code 的分层语义：`userSettings`、`projectSettings`、`localSettings`、`flagSettings`、`policySettings`、`cliArg`、`command`、`session`。MyAgent 可以将这些来源映射到自己的配置存储，不要求建立八套独立存储；但来源的优先级、可修改性和生命周期必须与 Claude Code 一致。

规则决策顺序固定为：

```text
deny → ask → allow
```

顺序优先于规则具体程度。更具体的 allow 不能覆盖更宽的 deny，更具体的 allow 也不能覆盖 ask。工具级 deny 还可以将工具从模型可见工具集合中移除；带内容限定的 deny 则在调用时拒绝。

### 2.4 Claude Code 的模式语义

官方文档将模式定义为对工具调用审批方式的控制：[Configure permissions](https://code.claude.com/docs/en/permissions)、[Permission modes](https://code.claude.com/docs/en/permission-modes)。

| 用户模式 | Claude Code 语义 | MyAgent 同构语义 |
| :--- | :--- | :--- |
| `Manual` / `default` | 默认模式，未被规则明确覆盖且需要权限确认的调用进入询问 | 保持默认规则和按调用判断的审批行为 |
| `Edit automatically` / `acceptEdits` | 自动接受文件编辑和工作目录内常见文件系统命令 | 只自动接受编辑类操作，不自动接受所有命令 |
| `Plan` / `plan` | 允许读取和只读 shell 探索，不编辑源文件 | 通过模式规则和工具检查限制编辑，不在工具中写 Plan 特判 |
| `Auto` / `auto` | 使用后台安全分类器自动批准低风险调用 | 接入 MyAgent 的 OpenAI 分类器适配层，保持失败和拒绝语义 |
| `Don't Ask` / `dontAsk` | 将未预先允许的 ask 转换为 deny | 无交互环境下拒绝未预授权操作 |
| `Bypass Permissions` / `bypassPermissions` | 跳过普通询问，但显式 ask 规则和 circuit breaker 仍生效 | 保持同样的绕过边界，不等同于无条件放行 |

截图中的 `Manual`、`Edit automatically`、`Plan`、`Auto` 是统一模式选择器中的产品标签；它们不是两个公开维度的组合。`bypassPermissions` 和 `dontAsk` 可以作为高级或非默认入口，但仍属于同一个 `PermissionMode`。

### 2.5 Claude Code 的真实调用链

Claude Code 并不是让工具只描述一个抽象操作对象，而是采用“统一流程 + 工具特有权限检查”。MyAgent 可以将统一流程实现为 `ToolPermissionService`，但不能改变以下顺序：

```text
ToolCall
  ↓
全工具 deny / ask 规则
  ↓
tool.checkPermissions(input, context)
  ↓
工具级 deny、内容级 ask、安全检查
  ↓
bypassPermissions 判断
  ↓
allow 规则匹配
  ↓
passthrough 转 ask
  ↓
dontAsk / auto classifier / headless fallback
  ↓
PermissionDecision
  ↓
PermissionPromptAdapter（仅处理 ask）
  ↓
应用 PermissionUpdate
  ↓
ToolExecutor 执行
```

因此 MyAgent 不应再新增 `OperationInspector`、`OperationDescriptor`、`PolicyConstraint`、`ExecutionPolicy` 或自定义 `PermissionEngine` 输入协议。可以有一个承载实现的 `ToolPermissionService`，但其行为必须对应 Claude Code 的 `hasPermissionsToUseTool` / `hasPermissionsToUseToolInner`，不能以新的领域契约替代 Claude Code 原语。

新架构中删除 `ApprovalPolicy`。规则匹配、模式处理和审批建议属于同一个权限决策流程；`PermissionPromptAdapter` 只消费最终的 `ask` 结果及其 `PermissionUpdate` 建议，不再自行解释模式、风险或 Plan。

授权结果通过 Claude 风格的 once/session/persistent 规则更新实现，不再建立 capability 权限领域模型。若 `ToolExecutor` 仍可能被其他模块直接调用，可以在封装边界内保留不可伪造的调用上下文，用于证明调用已经经过 `ToolPermissionService`；该上下文不叫 capability，不参与授权生命周期，也不产生新的 allow/ask/deny 语义。首选封装方式是：

```text
ToolCallGateway
  ├─ ToolPermissionService
  ├─ PermissionPromptAdapter
  └─ ToolExecutor（不对其他模块公开）
```

### 2.6 Claude Code 的模式状态转换

模式切换必须集中实现，保持以下状态语义：

- 进入 `plan` 时保存 `prePlanMode`；
- 离开 `plan` 时恢复 `prePlanMode`；
- 进入 `auto` 时移除会绕过分类器的危险 allow 规则；
- 离开 `auto` 时恢复被移除的危险规则；
- `plan` 是否保留 auto classifier 语义由明确配置决定；
- `bypassPermissions` 和 `auto` 具备独立的可用性开关；
- 模式切换、CLI 快捷键、SDK 控制消息和恢复会话都必须调用同一个转换入口。

同构实现的状态转换边界对应 Claude Code 的：

- `transitionPermissionMode`；
- `prepareContextForPlanMode`；
- `stripDangerousPermissionsForAutoMode`；
- `restoreDangerousPermissions`。

### 2.7 Claude 参考行为夹具

规则语法和工具检查是最容易出现“名称相同但行为不同”的部分。OpenSpec 必须建立可重复执行的参考行为夹具：

```text
同一组 PermissionRule
+ 同一组工具输入
+ 同一 PermissionMode
→ Claude Code 参考实现决策
→ MyAgent 同构实现决策
```

至少覆盖：

- 工具级 allow、ask、deny；
- 内容限定规则；
- deny/ask/allow 冲突和优先级；
- Bash 通配、命令前缀、复合命令和 process wrapper；
- 相对路径、工作目录路径、绝对路径和路径通配；
- MCP server 规则和具体 MCP tool 规则；
- `plan`、`auto`、`dontAsk`、`bypassPermissions`；
- `passthrough` 转最终 `ask`；
- once/session/persistent 对应的 `PermissionUpdate`；
- 工具检查、权限提示和执行器之间没有绕过统一入口的路径。

兼容测试关注的是最终行为和规则更新结果，不要求源码结构或内部类名相同。

## 3. 方案对比与推荐方向

| 评估维度 | Claude Code 行为同构 | MyAgent 自定义权限模型 | 结论 |
| :--- | :--- | :--- | :--- |
| 权限原语 | 已被真实产品验证 | 需要自行证明每个语义 | 采用同构实现 |
| 模式语义 | `PermissionMode` 清晰，模式选择器统一 | 容易重新拆成二维矩阵 | 采用同构实现 |
| 工具边界 | 工具保留 `checkPermissions`，支持工具特有规则 | 需要重新设计 OperationDescriptor | 采用同构实现 |
| 规则配置 | `Tool(specifier)`，deny/ask/allow | 当前多个安全结果契约混杂 | 采用同构实现 |
| 审批复用 | 通过规则更新和 session source 实现 | 当前依赖 capability 生命周期 | 移除 capability 核心语义 |
| Auto | 分类器作为 ask 的后处理，并防止危险 allow 绕过分类器 | 需要重新定义 unknown、confidence 和风险矩阵 | 采用同构实现 |
| 平台适配 | 只替换消息协议、工具注册和交互实现 | 可能连权限协议一起重写 | 仅保留适配层差异 |

**推荐路径**：以 Claude Code 权限行为规范为唯一基线，优先实现类型、规则解析、权限检查流程、模式状态转换和规则更新机制；MyAgent 只实现以下平台适配器：

1. OpenAI 工具调用输入与 Claude `ToolCall` 之间的适配；
2. MyAgent `ToolRegistry` / NativeTool / MCP 工具到 Claude `Tool` 接口的适配；
3. MyAgent CLI 交互到 Claude `CanUseTool` / permission prompt 的适配；
4. MyAgent 的 OpenAI 安全分类器调用适配；
5. MyAgent 配置文件到 Claude 权限来源的存储适配。
6. Claude `ToolExecutor` 调用上下文到 MyAgent 内部执行封装的适配。

除上述适配外，不新增权限概念，不将 capability、effect、risk、confidence、hardline 或 unknown 作为核心权限模型字段。实现可以使用不同的类名和目录组织，但不能改变 Claude Code 的行为契约。

## 4. 约束、风险与未知项

- **行为同构不等于复制 Claude 私有基础设施**：Analytics、GrowthBook、Anthropic SDK 和 Claude 专有工具需要替换，但替换只能发生在适配层，不能改变权限行为。
- **Auto 分类器的实现协议仍需确定**：MyAgent 使用 OpenAI 模型，但分类器输入、失败时行为、拒绝次数限制和 headless 行为应先对齐 Claude Code，再选择具体模型调用方式。
- **工具检查必须完整迁移**：文件、终端、PowerShell、MCP、Agent 等工具都要提供 Claude 风格的 `checkPermissions`，不能只迁移中央规则表。
- **规则解析是高风险部分**：Bash 复合命令、PowerShell AST、路径规则、通配符、MCP 名称和符号链接行为不能先用简单字符串匹配替代。
- **当前 capability 需要删除权限中心地位**：一次批准、会话批准和持久批准应通过 Claude 风格的 `PermissionUpdate` 写入 session 或配置规则；如果执行器需要防绕过，只能保留不可伪造的内部调用上下文。
- **`ApprovalPolicy` 必须删除**：不能将其改名后继续保留为第二个模式或风险决策入口；审批适配器只消费 `ask` 结果和规则更新建议。
- **Plan 特殊写入不应自行发明**：除非 Claude Code 的对应工具语义明确允许，否则不增加“计划文件例外”“诊断文件例外”等 MyAgent 专有白名单。
- **工具裁剪不是权限边界**：模型提示和工具列表可以优化行为，但最终权限必须由移植后的权限流程执行。
- **模式迁移不提供兼容别名**：本项目没有历史兼容负担，直接删除 `WorkMode`、`PlanSideEffect` 和旧审批结果契约。

## 5. 否决方案

- **继续完善 `TaskPhase × ApprovalMode`**：与 Claude Code 的单一模式选择器不一致，会重新制造组合矩阵。
- **引入 `OperationDescriptor` 作为全新核心协议**：这不是 Claude Code 的真实权限边界，属于再次造轮子。
- **保留 capability 作为权限中心**：Claude Code 的直接模型通过规则更新和 session source 复用授权，不以 capability 作为核心授权对象。
- **只移植 `PermissionMode` 枚举**：如果不同时移植规则解析、工具 `checkPermissions`、模式转换和 Auto 后处理，最终仍是旧模型套新名称。
- **继续保留旧 `SafetyCheckResult`、`PlanSideEffect` 和执行器兜底审批**：会形成新旧决策链并存。
- **现在吸收其他竞品的局部设计**：本阶段优先建立 Claude Code 同构基线，待同构实现完成并验证后，再单独评估是否需要扩展。

### 最终迁移验收标准

完成后必须满足以下静态和运行时验收条件：

```text
WorkMode                    = 0 处
PlanSideEffect              = 0 处
SafetyCheckResult           = 0 处
工具读取 PermissionMode     = 0 处
执行器内部人工审批          = 0 处
ApprovalPolicy              = 0 处
所有工具调用绕过统一入口    = 0 条
```

允许存在的是：

- 工具内部的 `checkPermissions`；
- 权限服务内部对 `PermissionMode` 的解释；
- 执行器内部不可伪造的调用上下文；
- 面向 Claude 行为的参考夹具和兼容测试。

这些允许项不能重新形成第二套授权语义。
