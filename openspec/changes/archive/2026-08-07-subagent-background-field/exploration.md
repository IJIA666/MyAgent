# 3c 探索：定义级 background 字段启用（强制后台）

> 状态: active
> 创建: 2026-08-07
> 依据: 官方源码核实（verificationAgent.ts:138、AgentTool.tsx:426/548/567）+ MyAgent 现状核实（AgentDefinitionLoader DEFERRED_FIELDS、SubagentCoordinator 提交点）
> 上游: openspec/explorations/subagent-evolution-roadmap.md 阶段 3c

---

## 1. 目标

启用子代理定义 frontmatter 的 `background` 字段（2a 时列为未启用字段）：声明 `background: true` 的定义强制后台运行——模型调用该类型时即使不传/传反 `run_in_background` 也按后台执行（对齐官方 verificationAgent 语义）。

## 2. 官方机制核实

- `VERIFICATION_AGENT`（verificationAgent.ts:134-138）：`agentType: 'verification'` + `background: true`。
- 消费点（AgentTool.tsx:426/548/567）：`shouldRunAsync = (run_in_background === true || selectedAgent.background === true || ...) && !isBackgroundTasksDisabled`——**定义级 background 与工具参数 run_in_background 为 OR 关系**：模型传 `run_in_background: false` 不覆盖定义级 `background: true`（仍强制后台）；`isBackgroundTasksDisabled` 开关可整体关闭后台能力（MyAgent 无对应物）。
- 官方不在 Agent 工具 schema 中提示该字段（模型无从得知类型是否强制后台，由定义决定）。

## 3. MyAgent 现状核实

| 事实 | 证据 | 结论 |
|---|---|---|
| background 当前未启用 | `DEFERRED_FIELDS` 含 'background'（AgentDefinitionLoader.ts:22），解析忽略 + warning | 从清单移除并启用解析 |
| 提交点后台判定 | `background = forceExactFork \|\| forkEnabled \|\| request.runInBackground === true`（SubagentCoordinator.ts） | 追加 `\|\| definition.background === true`（OR 语义对齐官方） |
| 定义接口 | `SubagentDefinition` 无 background 字段（SubagentDefinitionRegistry.ts） | 加 `background?: boolean` |
| 后台执行链 | 1 阶段已完备（后台注册、autoBackgroundMs、白名单、task-notification） | 零新增，仅提交点强制 |
| 恢复路径 | resumeTask 已强制后台（3a） | 一致，无需改 |
| `--agent` 主会话 | agent-session-mode spec 已列 background 主线程不生效 | 无需改 |
| 内置定义 | general-purpose/Explore/Plan 无 background（内置常量构建，非 frontmatter） | 仅 .md 自定义定义走 frontmatter 解析 |

## 4. 设计要点

1. `AgentDefinitionLoader`：background 移出 DEFERRED_FIELDS；解析为布尔（非布尔值 fail-closed 拒绝定义，对齐 tools/model 等字段的处理风格）。
2. `SubagentDefinition.background?: boolean`。
3. 提交点：`background = forceExactFork || forkEnabled || request.runInBackground === true || definition.background === true`。
4. 非法值语义：对齐 2a fail-closed——非布尔 background 拒绝该定义（不静默忽略）。

## 5. 验收

- 定义声明 `background: true` 后，模型调用该类型（无论是否传 run_in_background）一律返回 `async_launched` 后台执行。
- 未声明 background 的类型行为不变（保持前台/显式后台）。
- 非法 background 值（如字符串）拒绝定义并记录可诊断日志。
