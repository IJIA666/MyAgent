## 改造原因

阶段 0/1 完成后，子代理体系只支持 `general-purpose` 与 `exact-fork` 两个**固定内置**类型（见 `SubagentDefinitionRegistry` 注释："第一阶段只内置 general-purpose，不扫描 Markdown"）。这带来三个与官方行为不等价的缺口：

1. **用户无法自定义子代理类型**：官方支持 `.claude/agents/*.md`（项目层）与 `~/.claude/agents/*.md`（用户层）定义文件，写一个 Markdown 文件即获得新子代理类型；MyAgent 目前完全不具备。
2. **缺少只读探索/规划代理**：官方内置 Explore（快速只读搜索）与 Plan（只读架构规划），MyAgent 没有对应用途的代理，主模型只能调用全工具池的 general-purpose，既慢又不安全。
3. **模型无法指定子代理模型**：官方 Agent 工具支持 `model` 参数，并有一套 env > 工具参数 > frontmatter > inherit 的解析链（`utils/model/agent.ts`）；MyAgent 的 Agent 工具 schema 只有 description/prompt/subagent_type/run_in_background 四个字段，子代理模型完全跟随父会话。

本 change 是子代理演进路线图（`openspec/explorations/subagent-evolution-roadmap.md`）阶段 2 的**核心子集**（2a）：只做"配置型子代理"的骨架能力。`--agent` 会话模式、hooks 映射、子代理专属 MCP、子代理记忆（memory 字段）明确**不在本 change 范围**，留待 2b 单独评估。

## 变更内容

- **配置型子代理定义加载**：新增 `.myagent/agents/*.md` 与用户层 `~/.myagent/agents/*.md` 定义加载器，对齐官方 `loadAgentsDir.ts` 的分层优先级（built-in > user > project）。类型名取自 **frontmatter `name`**（必填，对齐官方 `parseAgentFromFile` 语义），文件名仅作诊断信息。frontmatter 字段按 MyAgent 实际能力分层落地：**生效**——`name`、`description`（均必填）、`tools`、`disallowedTools`、`model`、`maxTurns`、`permissionMode`（仅允许收窄到 `plan` 或保持父模式，不得提升）、`omitClaudeMd`；**解析但忽略并记录 warning**——`effort`（MyAgent 无 effort 能力）、`color`（无 UI 面板）、`skills`（预加载机制留 2b）、`background`（定义级强制后台留 2b）、`memory`/`mcpServers`/`hooks`/`isolation`（2b 或不在计划）。`.md` 正文作为子代理系统提示；`initialPrompt` 与 `agents.json` 配置格式不在 2a 范围。plugin 层留接口不实现。
- **内置 Explore / Plan 子代理**：对齐官方 `built-in/exploreAgent.ts` / `planAgent.ts`——只读**允许名单**工具池（对齐 MyAgent 实际注册名，含搜索/读取/只读 Shell 等）、固定 `permissionMode: plan`（经权限网关强制只读，即使父会话为 bypass 也收窄）、`omitClaudeMd: true`（不加载 CLAUDE.md 规则）、只读搜索专家/架构规划师系统提示。**BREAKING（子代理工具面）**：Explore/Plan 出现在模型可选的 `subagent_type` 清单中，且其工具面显著收窄。
- **general-purpose 完善**：对齐官方 `generalPurposeAgent.ts` 的 `tools: ['*']` 全工具池语义，替换当前 freshForeground 默认池语义。
- **model 解析**：新增子代理模型解析链（env `MYAGENT_SUBAGENT_MODEL` > Agent 工具 `model` 参数 > 定义 frontmatter `model` > `inherit`），模型值限 `inherit` 与已注册 profile ID（`BUILTIN_MODELS`）；未知 ID 返回校验错误而非静默回退。MyAgent 无 Claude 式族别名与 tier 体系，官方 `aliasMatchesParentTier` 语义不在 2a 落地（待模型注册表扩展 alias/tier 能力后评估）。**BREAKING（Agent 工具 schema）**：Agent 工具新增 `model` 参数，模型可见 schema 变化。
- **omitClaudeMd 语义**：明确为"不加载 CLAUDE.md 规则投影"。长期记忆投影对**所有** fresh 子代理均不加载（既有现状，`createEmptyMemorySnapshot`），与 omitClaudeMd 字段无关。

## 业务能力

### 新增业务能力
- `configured-subagent-definitions`: 从 `.myagent/agents/*.md` 与用户层 agents 目录加载并注册子代理定义，支持 frontmatter 字段解析、分层优先级与工具池声明（tools/disallowedTools）。
- `builtin-explore-plan-agents`: 内置 Explore（快速只读搜索）与 Plan（只读架构规划）子代理，只读工具池 + omitClaudeMd。
- `subagent-model-resolution`: 子代理模型解析链（env > 工具参数 > frontmatter > inherit）与 Agent 工具 `model` 参数。

### 修改业务能力
- `subagent-execution`: 现有需求变化——(a) `SubagentDefinitionRegistry` 从固定内置注册扩展为可动态注册（含文件加载注册）；(b) Agent 工具 schema 增加 `model` 参数并纳入校验；(c) 工具作用域策略支持按定义声明收窄（Explore/Plan 只读池）。

## 影响范围

- **核心用例**：`src/core/usecases/subagent/SubagentCoordinator.ts`（**生产执行路径**：定义解析、模型/权限/循环上限在提交点冻结消费）、`SubagentDefinitionRegistry.ts`（扩展动态注册与定义字段）、`SubagentContextBuilder.ts`（自定义正文组装进系统提示）、`ScopedToolRegistry.ts`（定义级工具池收窄）、`SubagentRuntime.ts`（透传冻结输入）。
- **工具适配**：`src/adapters/tools/impl/agent/AgentTool.ts`（新增 model 参数与 schema）。
- **新增模块**：`.md` 定义加载器（对齐 loadAgentsDir.ts，含 frontmatter 解析、分层目录扫描、memoize）。
- **配置**：环境变量 `MYAGENT_SUBAGENT_MODEL`；`subagentForkEnabled` 开关语义不变。
- **依赖**：无新增第三方依赖；frontmatter 解析复用现有 YAML 解析工具（如有）或引入最小实现（待 design 定）。
