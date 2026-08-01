## 改造原因

MyAgent 已能扫描、展示和按需加载 Markdown Skill，但当前 Skill 只能由人工维护：主 Agent 完成复杂任务、绕过错误路径或接受用户纠正后，成功经验不会被稳定复用；已有 Skill 失效时也没有自动修补入口；持续新增 Skill 后缺少使用统计、归档和相似能力融合机制。

Hermes Agent 已验证了“专用 Skill 管理工具、主回复后的隔离复盘 Agent、独立 Curator”这一闭环形态。现在引入该能力，可以先让 MyAgent 学会沉淀和维护程序性知识，再用纯文字小红书发帖等真实任务验证复用效果，而不需要为每个平台预先开发专用业务工具。

## 变更内容

- 新增 `skill_manage` 原生工具，以 `create`、`patch`、`edit`、`delete`、`write_file`、`remove_file` 管理 Skill 包，并在每次操作中执行名称、frontmatter、路径、大小和所有权检查。
- 在一次主 Agent 运行正常结束且累计工具迭代达到配置阈值后，于用户回复交付后启动隔离的后台 Skill Review Agent；它只能读取 Skill 并调用 `skill_manage`，优先更新已有 Skill，确无合适载体时才创建新的 class-level Skill。
- 为 Skill 写入增加可选的暂存批准开关；关闭时按正常工具权限执行，开启时所有 Skill 变更进入持久 pending 区，由用户查看差异后批准或拒绝。
- 记录 agent-created Skill 的查看、使用、修改和最后活动信息，并区分 active、stale、archived 与 pinned 状态；手写、项目维护或未显式交给 Curator 的 Skill不得被后台自动维护。
- 新增 Curator：默认执行确定性的过期状态迁移和可恢复归档；LLM umbrella 融合默认关闭，支持手动运行、dry-run、运行前备份、恢复、pin/unpin 和显式 adopt。
- 融合时优先把窄 Skill 吸收到 class-level umbrella 的正文或支持文件中，再归档被吸收的旧 Skill；完整扫描候选集合，但不得设置“至少归档多少个”之类的数量指标。
- 保留 MyAgent 当前基于模型自主推理的 ReAct 运行方式，不引入 LangGraph 等预定义工作流引擎。
- 第一版不增加跨多个 `skill_manage` 调用的事务、版本锁或 `SkillChangeSet`；每次工具动作独立返回成功或失败。

## 业务能力

### 新增业务能力

- `agent-managed-skills`: 通过专用工具安全创建、查看、更新、扩展、删除或归档 Markdown Skill，并支持可选的写入暂存批准。
- `background-skill-learning`: 在主回复之后使用受限后台 Agent 复盘真实任务轨迹，把可复用程序性经验更新到 Skill 库，并允许无有效学习时不写入。
- `skill-curation`: 通过所有权标记、使用遥测、状态迁移、可恢复归档和可选 umbrella 融合控制 agent-created Skill 的长期质量与规模。

### 修改业务能力

无。

## 影响范围

- Skill 发现与缓存：`src/core/usecases/brain/contextLoader.ts`、`src/core/usecases/brain/RuleManager.ts` 及新的 Skill 管理、使用状态和 Curator 模块。
- Agent 生命周期：`src/core/usecases/engine/agent-loop.ts`、`src/core/usecases/engine/session.ts`、插件生命周期与后台受限 Agent 运行边界。
- 原生工具与权限：`src/adapters/tools/impl/skill/`、`src/adapters/tools/tool-factory.ts`、`src/adapters/tools/toolRegistry.ts`、有副作用入口清单和新的 Skill 权限适配器。
- 配置与交互：`src/config/types.ts`、`src/config/loader.ts`、`src/config/settings-repository.ts`、`/skill` 管理子命令及新的 `/curator` 命令。
- 持久数据：用户 Skill 根下新增 usage、pending、archive、Curator state 和 backup 元数据；不增加数据库、向量库或新的生产依赖。
- 测试与文档：新增 Skill 管理、后台学习、Curator、权限和 CLI 测试，并补充用户可见的 Skill 自学习与恢复说明。
- 不实现小红书发布、图片上传、平台登录或其他具体业务流程。
