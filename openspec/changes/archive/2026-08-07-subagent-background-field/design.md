## 背景

2a 将 `background` 列入 `DEFERRED_FIELDS`（AgentDefinitionLoader.ts:22，解析忽略 + warning）。后台执行链（后台注册、autoBackgroundMs、白名单收窄、task-notification、outputFile）自 1/3a 阶段已完备，且恢复路径已强制后台。启用该字段只需：定义解析启用 + 提交点后台判定追加 OR 项。

## 目标与非目标

**目标:**
- `background: true` 的定义被模型调用时强制后台（返回 `async_launched`），模型传 `run_in_background: false` 不覆盖。
- 非布尔 `background` 值 fail-closed 拒绝定义（对齐 2a 字段处理风格）。

**非目标:**
- Agent 工具 schema 提示后台类型（官方不提示，模型由定义决定）。
- `isBackgroundTasksDisabled` 等价开关（MyAgent 无对应物）。
- `--agent` 主会话消费 background（agent-session-mode 既有契约：主线程不消费）。
- 内置定义 background（general-purpose/Explore/Plan 无此语义，仅 .md 自定义定义走 frontmatter）。

## 架构决策

### D1: 定义解析启用（布尔 fail-closed）

- `AgentDefinitionLoader`：`background` 移出 DEFERRED_FIELDS；解析为布尔（`matter` frontmatter 的布尔原生类型）。非布尔值（字符串/数字/数组）→ 拒绝该定义并记录可诊断日志（对齐 tools/model/maxTurns 的 fail-closed 风格，不静默忽略）。
- `SubagentDefinition.background?: boolean`（缺省 undefined = 未声明，行为不变）。

### D2: 提交点 OR 强制（对齐官方 AgentTool.tsx:567）

- `SubagentCoordinator.submitRequest`：
  ```ts
  const background = forceExactFork
    || this.options.forkEnabled === true
    || request.runInBackground === true
    || definition.background === true;
  ```
- 为什么 OR 而非覆盖：官方语义 `run_in_background || selectedAgent.background`——模型传 false 不覆盖定义级 true（模型无法把强制后台类型改为前台，正是"强制"的含义）。
- exact-fork/fork 路径不受影响（definition 为 exactForkDefinition，background 未声明）。

### D3: 无新增执行链

- 后台执行全链已存在（TaskManager background 模式、freshBackground 工具策略、白名单、notified 通知、outputFile 返回），提交点强制后自动生效；`definition.toolPolicyKey` 后台分支已正确（3a 修正过 freshBackground）。

## 风险与权衡

- [模型误以为可前台调用强制后台类型] -> 与官方一致（模型无感知）；Agent 工具返回 async_launched 即事实语义。
- [非法 background 值拒绝定义影响面] -> 与既有 fail-closed 字段一致；warning 说明原因，不影响其他定义加载。

## 迁移计划

- 无数据迁移；未声明 background 的定义行为不变；非法值从"忽略 + warning"变为"拒绝定义"（行为收紧，spec 明示）。

## 待确认问题

- 无（探索期已核实：官方 OR 语义、MyAgent DEFERRED_FIELDS 现状、提交点判定、恢复路径一致性、--agent 契约）。
