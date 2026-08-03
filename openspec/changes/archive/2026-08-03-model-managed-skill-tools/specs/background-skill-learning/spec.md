## MODIFIED Requirements

### Requirement: 后台工具面固定收窄

Review Agent 的有效工具面 MUST 是父 Agent 工具面与固定 `{skills_list, load_skill, skill_manage}` 集合的交集。Memory、普通文件、Shell、Browser、MCP、交互和外部副作用工具 MUST 被拒绝，且 Review 不得请求人工批准。`skills_list` MUST 只用于目录发现，MUST NOT 扩大后台写入权限或替代 `load_skill` 的准确目标读取凭证。

#### Scenario: Review 获取三类 Skill 工具

- **WHEN** 父 Agent 同时提供 `skills_list`、`load_skill`、`skill_manage` 和其他工具
- **THEN** Review 模型只看到 `skills_list`、`load_skill` 和 `skill_manage`
- **THEN** 三个工具调用继续经过共享 ToolGateway 和独立后台权限快照

#### Scenario: Review 尝试调用 Shell

- **WHEN** 后台模型请求 Bash 或 PowerShell
- **THEN** 系统在执行前拒绝调用
- **THEN** 不得因为父 Agent 拥有 Shell 而扩大后台工具面

#### Scenario: Review 尝试修改未拥有的 Skill

- **WHEN** Review 调用 skill_manage 指向未标记为 curator-managed 的 Skill
- **THEN** Skill 工具的所有权检查拒绝修改

### Requirement: 复盘优先更新已有 Skill

Review Agent MUST 先通过 `skills_list` 获取当前实时目录，再按“本轮已加载 Skill、已有 class-level umbrella、已有 umbrella 支持文件、新建 class-level Skill”的顺序选择承载位置。目录结果为 `complete: false` 时，Review MUST 使用更具体的 `category` 或 `query` 继续筛选，并在取得覆盖相关候选的完整结果前 MUST NOT 断言“不存在合适 Skill”或创建新 Skill。对任一已有候选执行修改前，Review MUST 通过 `load_skill` 读取动作所需的准确主文件或支持文件。只有完整目录发现和候选读取均表明前序位置不适用时，才允许创建新 Skill。

#### Scenario: 已加载 Skill 缺少本轮发现的步骤

- **WHEN** 本轮使用了一个 agent-created Skill，成功路径暴露其缺失步骤
- **THEN** Review 先取得实时目录并通过 `load_skill` 读取该 Skill 的当前内容
- **THEN** Review 优先 patch 该 Skill，而不是创建只描述本轮问题的新 Skill

#### Scenario: 目录中存在未在启动快照中的 umbrella

- **WHEN** 活跃会话启动后出现一个能够承载本轮知识的 class-level umbrella
- **THEN** Review 通过 `skills_list` 发现该实时条目并使用 `load_skill` 检查其内容
- **THEN** Review 不得仅因启动时 `<available_skills>` 未列出它而创建重复 Skill

#### Scenario: 没有合适的已有 Skill

- **WHEN** Review 已取得覆盖相关候选且 `complete: true` 的实时目录结果并读取合理候选，本轮仍产生了现有 Skill 均不覆盖的可复用程序性知识
- **THEN** Review 可以创建带明确触发条件、步骤、陷阱和验证方法的 class-level Skill

#### Scenario: 未筛选目录超过输出预算

- **WHEN** Review 首次调用 `skills_list` 得到 `complete: false` 的目录结果
- **THEN** Review 使用与本轮知识相关的分类或关键词继续缩小匹配集合
- **THEN** Review 不得把未返回的条目视为不存在，也不得基于该不完整结果创建新 Skill
- **THEN** 无法取得相关完整目录时，本轮必须安全 no-op，而不是冒险创建重复 Skill
