## 改造原因

MyAgent 已允许模型通过 `load_skill` 读取 Skill、通过 `skill_manage` 维护 Skill，但缺少一个低成本、只暴露元数据的实时目录工具。模型若要判断当前有哪些 Skill、是否已有可复用目标，只能依赖会话启动时冻结在系统提示词中的 `<available_skills>`，或逐个猜测名称后读取全文。后台 Skill Review 与 Curator 融合 Agent 因而也无法在不破坏提示词缓存的前提下浏览最新目录，容易遗漏同类 Skill 或创建重复能力。

现在补齐目录浏览、完整读取、受控写入三段职责，可以让前台模型、后台 Review 与 Curator 融合 Agent 使用同一套清晰、渐进展开的 Skill 管理工具，同时继续保持会话系统提示词稳定和后台先读后写约束。

## 变更内容

- 新增只读原生工具 `skills_list`，从当前 `SkillLibrary` 合并视图返回实时 Skill 元数据，支持按分类和关键词筛选；列表只提供名称、描述摘要、分类和来源，不读取正文、不增加查看次数。结果在工具自身的字节预算内始终保持合法 JSON，并通过 `complete` 明确声明当前筛选结果是否完整；结果过大时要求继续缩小筛选范围，不把任意固定配额误写成“必然容纳全部 Skill”。
- **BREAKING**：把 `load_skill` 的纯正文字符串结果改为结构化 JSON 结果，明确返回 Skill 元数据、实际读取文件、完整内容和可读取的支持文件列表；同时移除无法提供目录与元数据语义的旧 `loadSkill` 回调装配路径，统一由 `SkillLibrary` 提供数据。工具名称保持不变，不新增职责重复的 `skill_view`。
- 保留 `skill_manage` 的六种动作、权限、审批、所有权、锁和先读后写约束，不改变写入语义；后台读取账本从新版 `load_skill` 结果的 `content` 字段记录模型实际看到的准确内容。
- 将后台 Skill Review 与共用隔离执行器的 Curator 融合 Agent 固定工具上限从 `{load_skill, skill_manage}` 调整为 `{skills_list, load_skill, skill_manage}`。Review 必须先取得完整的相关目录结果、再读取候选 Skill，最后才决定更新或创建；Curator 可用目录补充发现当前 landscape，但其可修改范围仍只由本轮输入的 curator-managed 候选决定。
- 保留会话启动时的 `<available_skills>` 快照用于自动匹配；`skills_list` 只提供实时主动查询，不触发系统提示词重建或历史改写。

## 业务能力

### 新增业务能力

无。

### 修改业务能力

- `agent-managed-skills`: 增加实时 Skill 目录工具，并定义 `load_skill` 的结构化读取结果和三类工具的职责边界。
- `background-skill-learning`: 后台 Review 的固定工具面增加 `skills_list`，并按目录浏览、候选读取、受控写入的顺序决策。
- `skill-curation`: Curator 融合 Agent 同步获得三工具目录，并保持候选所有权范围与准确预读约束不变。
- `rules-injection-caching`: 明确活跃会话可通过 `skills_list` 查询实时 Skill 目录，同时保持冻结的系统提示词快照不变。

## 影响范围

- Skill 原生工具实现与统一装配：`src/adapters/tools/impl/skill/`、`src/adapters/tools/tool-factory.ts`；内部 `BuildNativeToolsOptions.loadSkill` 兼容入口被移除。
- 内建工具命名保护与副作用入口清单：`src/adapters/tools/mcp-client.ts`、`src/adapters/tools/effectful-entrypoints.ts`。
- 后台 Review/Curator 共用工具白名单、读取账本解析和提示词：`src/core/usecases/brain/background-skill-agent.ts`、`background-skill-review.ts`、`skill-curator-prompt.ts`。
- Skill 工具、后台隔离、契约与真实链路测试；现有依赖方需要从 `load_skill` 的 JSON 结果中读取 `content`，不再把整个返回值视为正文。
- 不新增第三方依赖，不改变 Skill 文件布局、`skill_manage` 写入格式或用户 CLI 命令。
