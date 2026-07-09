## 背景

当前 Plan 模式下的终端安全校验分为三层，但三层规则互不同构：

```
checkCommandSafetyLevel()  →  白名单前缀匹配（粗粒度）
       ↓
checkSafety() Plan 分支     →  白名单命中放行，非命中硬拦截
       ↓
validateCommand()           →  复合字符结构校验（严格拒绝 |, >, <, % 等）
```

**核心缺陷**：`checkCommandSafetyLevel` 判定 `dir /-C /w ... | find "..."` 为（白名单命中 → 'allow'），但 `validateCommand` 因 `|` 拒绝执行。前置审批可通过但执行期必定失败，造成"审批成功的假阳性"。

此前的 `plan-mode-terminal-self-healing` change 仅在 Plan 拦截报错中追加了自愈引导词，并未修复三层规则的分层脱节。本 change 从结构上消除这种不一致。

## 目标与非目标

**目标：**
1. Plan 模式下，前置审批层（`checkSafety`）的允许集合与执行期校验层（`validateCommand`）的允许集合同构
2. Plan 模式从"无终端模式"重新定义为"无副作用模式"：允许可静态证明安全的系统只读查询
3. Plan 模式下的安全只读查询继续走统一审批管线，不再出现"先审批、后执行期失败"的假阳性路径
4. 系统提示词中的 Plan 模式终端规则反映新的"无副作用"语义

**非目标：**
- 放宽复合 shell 语法（`|`、`>`、`<`、`%`、`$(` 等）
- 新增专用只读工具（如 `wmic` 包装器）
- 改变 YOLO / Auto / Safe 模式下的审批逻辑
- 修改 `terminal-engine.ts` 的进程执行逻辑
- 允许 Plan 模式下执行任何写操作
- 调整 `extractSafePrefix` 或持久化命令前缀授权模型

## 架构决策

### D1：引入统一的 Plan 安全判定函数 `isPlanSafeCommand`

在 `terminal-guard.ts` 中新增一个函数，将 Plan 模式的前置安全检查集中到单一点：

```
isPlanSafeCommand(command, shellKind) → boolean
  ├── 1. checkCommandSafetyLevel(command, shellKind) === 'allow'
  ├── 2. !isHardlineDangerous(command, shellKind)
  └── 3. validateCommand(command, shellKind) 不抛错  // 复用执行期结构校验
```

该函数被 `checkSafety()` 的 Plan 模式分支调用，用于保证前置判定与执行期结构校验的允许集合完全同构。这里必须按**当前已决议 shell family** 判定，而不能跨 shell 做"任一白名单命中即可"的宽松检查；否则会把当前 shell 下根本不可执行的命令错误地送进审批。

**替代方案**：直接修改 `validateCommand` 使其返回布尔值而非抛错，然后在 Plan 模式中调用。但 `validateCommand` 是执行期防线，其抛错语义被多处依赖，不宜改动。

### D2：Plan 模式拦截逻辑重构

当前 `terminal.ts` 中 Plan 模式分支（124-133行）：

```
// 当前逻辑（一刀切）：
if (workMode === 'Plan') {
  if (safetyLevel !== 'allow') {
    return { status: 'deny', message: '...自愈引导...' };
  }
}
// 问题：safetyLevel === 'allow' 时仍可能进入审批或执行后续路径，
// 但执行期 validateCommand 依然可能因复合字符而拒绝
```

重构后：

```
// 新逻辑（同构判定）：
if (workMode === 'Plan') {
  if (!isPlanSafeCommand(command, resolvedShellKind)) {
    return { status: 'deny', message: '...更新后的自愈引导...' };
  }
  // 通过结构安全判定后，继续走统一审批路径，不再在 Plan 分支里静默放行
}
```

**关键变化**：Plan 模式下，失败的命令直接返回 `deny`（带自愈引导）；只有真正满足只读白名单与原子结构约束的命令，才允许继续进入统一审批路径。这样既消除"可通过审批但实际无法执行"的中间态，又不绕开现有的用户审批护栏。

### D3：保持审批能力边界，不在本 change 扩大前缀授权粒度

当前 `extractSafePrefix` 要求第二个 token 必须是纯字母数字（`/^[a-zA-Z0-9]+$/`），这会导致部分参数化只读命令无法形成持久化前缀。但该问题与本次 change 的核心验收目标并不相同。

**决策**：本次 change 不修改 `extractSafePrefix`，也不新增新的持久化命令前缀语义。原因有二：
1. 将 `dir /-C ...` 回退为裸 `dir` 前缀，会扩大持久化授权粒度，属于独立的审批模型设计问题，不应在本次 Plan 边界修复中顺带引入。
2. 本次核心问题是"不该通过的命令却能进入审批"，而不是"某些安全命令无法形成持久化前缀"。前者是阻断一致性问题，后者是授权产品设计问题，验收边界不同。

### D4：系统提示词语义更新

当前 `RULE_TOOL_PRIORITY` 中 Plan 模式段落：

> 在只读规划（Plan）阶段下，智能体必须（MUST）仅调用只读原生文件工具进行诊断与状态分析，严禁调用 execute_command 进行任何分析或检索

更新为反映"无副作用"而非"无终端"的语义：

> 在只读规划（Plan）阶段下，智能体必须（MUST）优先使用只读原生文件工具（list_dir、read_file、grep_search）进行诊断与状态分析。当原生工具无法覆盖特定系统查询需求时，允许调用 execute_command 发起**可静态证明安全的系统只读查询**（如 dir、type、findstr 等白名单命令）的审批请求，但严禁任何复合连接、重定向、环境变量展开或写倾向操作。

## 风险与权衡

| 风险 | 缓解策略 |
|:---|:---|
| Model 可能滥用 Plan 终端查询能力，绕过原生工具优先原则 | 提示词中明确"优先使用原生工具，终端仅作为补充"的层级关系；`isPlanSafeCommand` 只放行白名单内且无复合字符的命令 |
| 白名单命令的"安全"判定可能不够充分（某些命令可能有信息泄露风险） | 当前白名单（dir、type、findstr、ls、cat 等）均为通用信息查询命令，不涉及进程枚举或系统配置暴露；后续可扩展为可配置名单 |
| Plan 模式继续保留审批，用户可能觉得"已经是只读了为什么还要批" | 宿主机查询不等于零风险；本次 change 的目标是让审批变得真实有效，而不是顺带取消审批 |
| Plan 模式放行只读终端查询后，context 中终端输出可能膨胀 | 现有的终端输出截断机制（`terminal-engine.ts`）对所有模式统一生效 |
| `isPlanSafeCommand` 与 `validateCommand` 仍为两个独立函数，存在未来不同步的可能 | `isPlanSafeCommand` 直接复用 `validateCommand` 做结构校验，避免再维护一套独立的引号感知与复合字符逻辑 |

## 迁移计划

1. **部署步骤**：本次变更为纯规则层修改，无数据迁移需求。部署后 Plan 模式的终端行为立即生效。
2. **回滚策略**：若发现某白名单命令在 Plan 模式下存在安全隐患，可通过从 `READONLY_COMMAND_WHITELISTS` 中移除该命令快速回滚，无需代码回退。
3. **向后兼容**：非 Plan 模式（Safe / Auto / YOLO）的终端行为完全不受影响。现有的 `validateCommand`、`checkCommandSafetyLevel` 函数签名不变。

## 未决问题

1. **白名单是否需要扩充**：当前白名单（dir、type、findstr 等）能覆盖常见只读诊断需求，但 `systeminfo`、`tasklist`、`netstat` 等更高级的系统诊断命令是否需要纳入？建议先观察实际使用情况，由后续 change 迭代。
2. **Plan 模式下命令审批是否需要专门的 choice 收缩**：如果未来希望在 Plan 中只允许 `call/deny` 而不暴露更宽的持久化命令授权，应在 approval-policy 侧另起 change 处理。
3. **是否需要在 Plan 模式下对终端输出做额外过滤**：某些只读命令的输出可能包含路径信息或系统配置，是否需要在 Plan 模式下做脱敏处理？当前倾向于不做额外过滤，因为 Plan 模式本身不限制信息获取（只限制副作用）。
