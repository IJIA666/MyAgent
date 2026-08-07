## 改造原因

子代理定义 frontmatter 的 `background` 字段在 2a 时列为未启用字段（DEFERRED_FIELDS，解析忽略 + warning）。官方 verificationAgent 用该字段声明"验证类代理强制后台运行"（verificationAgent.ts:138 `background: true`），模型调用时经 OR 语义强制后台（AgentTool.tsx:567 `run_in_background || selectedAgent.background`）。后台执行链自 1 阶段已完备，启用该字段只差定义解析与提交点强制，改动面小。

## 变更内容

1. `AgentDefinitionLoader`：`background` 从 DEFERRED_FIELDS 移除并启用解析——布尔值合法；非布尔值 fail-closed 拒绝该定义（对齐 tools/model 等字段的处理风格，不静默忽略）。
2. `SubagentDefinition` 接口新增 `background?: boolean`。
3. 提交点强制：`SubagentCoordinator.submitRequest` 的后台判定追加 `|| definition.background === true`（OR 语义对齐官方——模型传 `run_in_background: false` 不覆盖定义级 `background: true`）。
4. 未声明 background 的类型行为不变；恢复路径（3a）已强制后台，无需改；`--agent` 主会话不消费该字段（agent-session-mode 既有契约）。

无 BREAKING：新增字段启用，未声明的定义行为不变。

## 业务能力

### 新增业务能力
（无新增能力）

### 修改业务能力
- `configured-subagent-definitions`: 生效字段清单增加 `background`（强制后台）；"未启用字段静默失效但可诊断"场景更新（background 移出 warning 清单）；新增"background 声明强制后台"场景

## 影响范围

- `src/core/usecases/subagent/AgentDefinitionLoader.ts`：DEFERRED_FIELDS 移除 + background 布尔解析
- `src/core/usecases/subagent/SubagentDefinitionRegistry.ts`：定义接口加 background 字段
- `src/core/usecases/subagent/SubagentCoordinator.ts`：提交点后台判定追加定义级 background
- 测试：加载器 background 解析（true/false/非法值）、提交点强制后台（显式传 false 仍后台、未声明保持前台）
