# 探索主题: Agent Skill 学习闭环

## 1. 问题定义

MyAgent 当前能够发现、注入和按需加载用户级与项目级 Skill，但只能消费人工维护的 `SKILL.md`，缺少从真实任务轨迹中复盘可复用经验、更新已有 Skill、创建新 Skill，以及控制 Skill 数量增长的生命周期闭环。本次探索目标是复用 Hermes Agent 已验证的实现形态，而不是引入工作流引擎或额外的跨操作事务模型。

## 2. 关键发现与调研结果

- **代码库现状**：`contextLoader.ts` 与 `RuleManager.ts` 已支持用户/项目 Skill 扫描、项目 Skill watcher 和内容差异刷新；`load_skill` 仍是只读工具，ToolCatalog 中没有 Skill 写入工具；`SessionManager` 与 `AgentLoop` 已具备 RunStart、RunEnd、AfterModel、AfterTool 等生命周期接入点；统一 ToolGateway 要求新增有副作用工具提供正式权限适配器。
- **Hermes 日常学习**：Hermes 在主回复交付后启动隔离的后台 Review Agent，以累计工具迭代阈值为触发条件，只开放 memory/skill 工具；复盘顺序是优先修补本轮已加载 Skill、再更新已有 umbrella、再增加支持文件，最后才创建新的 class-level Skill。
- **Hermes Skill 管理**：`skill_manage` 提供 `create`、`patch`、`edit`、`delete`、`write_file` 和 `remove_file`；每个写操作独立完成校验和文件替换，不提供跨多次工具调用的变更集事务。
- **Hermes 生命周期**：Curator 记录使用、查看和修改次数，按活跃时间把 agent-created Skill 从 active 迁移到 stale、archived；LLM umbrella 融合默认关闭，运行前支持 dry-run、备份和恢复。
- **范围校准**：Hermes Curator prompt 中“少于 10 个归档说明停止太早”只是催促模型积极处理大规模 Skill 库的提示词，不是代码约束。它与本项目禁止指标驱动式评估的原则冲突，本次只保留“完整扫描候选集合”的意图，不复制固定归档数量。
- **Skill 与记忆边界**：成功轨迹只是学习证据；记忆保存“长期成立的事实、偏好和状态”，Skill 保存“某类任务如何执行”的可复用程序性知识。安全规则和权限上限仍由现有权限系统负责，不写入 Skill 代替。

## 3. 方案对比与推荐方向

| 评估维度 | 通用文件工具直接维护 Skill | Hermes 式 `skill_manage` + Review + Curator | 结论 |
| :--- | :--- | :--- | :--- |
| 模型操作语义 | 文件级，模型自行维持目录、frontmatter 和生命周期约束 | 以 create/patch/archive 等领域动作表达 | 采用 Hermes 形态 |
| 学习闭环 | 依赖主 Agent 临时决定，缺少回合后复盘 | 主回复后由隔离 Review Agent 复盘 | 采用后台 Review |
| Skill 膨胀 | 没有使用统计、归档和融合机制 | Curator 管理 agent-created Skill | 采用 Curator |
| 一致性边界 | 普通文件写入 | 单次 `skill_manage` 操作独立提交 | 不增加跨操作事务 |
| 融合策略 | 无 | class-level umbrella，默认关闭 | 保留可选融合，移除数量 KPI |

**推荐路径**：以 Hermes 当前实现为基线，在 MyAgent 内新增 `skill_manage`、回合后 Skill Review Agent 和 Curator 三个协作部分；复用现有 ReAct、ToolGateway、RuleManager 与 settings 体系，不增加 LangGraph 一类预定义工作流，不为第一版设计跨操作事务、版本锁或 `SkillChangeSet`。

## 4. 约束、风险与未知项

- RunEnd 的 `completed` 只表示运行正常交付了最终回复，不代表任务内容经过形式化正确性证明；后台 Review 仍需从轨迹中筛选有证据、可跨实例复用且带验证步骤的程序性知识，并允许合法 no-op。
- 对“先失败、后成功”的轨迹，优先保存最终验证过的正向路径；失败尝试只有在原因已验证且能写成带适用条件的 pitfall 时才可保留。
- 自动维护只能作用于有明确 agent-created 标记的本地 Skill，不能推断手写 Skill 的所有权。
- 用户 Skill 根会被多个 workspace 甚至多个 MyAgent 进程共用，usage sidecar 的完整读—改—写必须使用跨进程锁；Curator 的扫描结果只作为候选快照，归档前必须重新校验当前 ownership、pinned 和活动时间。
- `skill_manage(write_file)` 第一版只写 UTF-8 文本并限制大小，不提供二进制解码或写入入口；不使用扩展名白名单推断文件是否安全。
- 前台 `delete` 保持 Hermes 的硬删除语义，后台 `delete` 保持可恢复归档语义；origin 必须由宿主验证的 caller 派生，前台删除默认经过 ToolGateway 的显式询问。
- `skill_manage` 的多次调用可能部分成功；本次接受 Hermes 的单操作提交语义，通过明确结果、可恢复归档和 Curator 备份降低影响。
- 用户级与项目级同名 Skill 仍维持项目覆盖用户的既有优先级。
- 小红书纯文字发帖是后续用于检验 Skill 学习闭环的真实任务，不属于本 change 的发布功能范围。

## 5. 否决方案

- **通用文件工具直接承担 Skill 生命周期**：缺少稳定动作语义、所有权检查、使用统计和归档入口。
- **跨操作 Skill 事务、版本锁和变更集提交**：用户已明确第一版不要求超越 Hermes，本次不引入。
- **每次会话都必须产生 Skill 更新**：会诱发无证据写入和 Skill 污染，必须允许 `Nothing to save`。
- **固定归档数量目标**：容易为了数量错误合并，与项目评估约束冲突。
- **预定义工作流引擎**：与 MyAgent 的 Agentic 核心方向相悖，后台复盘和融合均由受限 Agent 自主决策。
