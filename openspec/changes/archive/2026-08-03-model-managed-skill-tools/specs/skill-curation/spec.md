## ADDED Requirements

### Requirement: Curator 融合 Agent 必须使用一致的 Skill 工具边界

Curator 融合 Agent 的有效工具面 MUST 是父 Agent 工具面与固定 `{skills_list, load_skill, skill_manage}` 集合的交集，其系统提示 MUST 准确说明三个可用工具。`skills_list` MAY 用于补充发现当前 Skill landscape，但本轮输入的 curator-managed、active/stale、非 pinned 候选 MUST 继续定义可修改的已有 Skill 范围；目录可见性 MUST NOT 授予输入范围外、unmanaged、pinned 或项目 Skill 的修改、采用或归档权限。创建新 umbrella 仍 MUST 通过既有 `skill_manage(create)` 策略校验。

候选输入携带的主文件正文只用于融合规划，MUST NOT 代替运行时先读后写凭证。Curator 修改任一已有主文件或支持文件前 MUST 使用准确的 `load_skill(name[, file_path])` 读取当前内容；`skills_list` MUST NOT 写入读取账本。

#### Scenario: Curator 获得与提示一致的三工具目录

- **WHEN** Curator 启动一次显式启用的融合运行，且父工具面包含三个 Skill 工具和其他工具
- **THEN** Curator 模型只看到 `skills_list`、`load_skill` 和 `skill_manage`
- **THEN** Curator 系统提示把 `skills_list` 描述为可选发现工具，并继续说明修改前必须准确 `load_skill`

#### Scenario: 目录发现输入范围外的 Skill

- **WHEN** Curator 通过 `skills_list` 发现一个不在本轮候选输入中的 unmanaged、pinned 或项目 Skill
- **THEN** Curator 可以把该元数据用于避免命名冲突或判断 landscape
- **THEN** 该发现不得扩大本轮已有 Skill 的修改、采用、删除或归档范围

#### Scenario: 候选正文不能替代准确预读

- **GIVEN** Curator 输入已经包含一个可维护候选的 `SKILL.md` 正文
- **WHEN** Curator 未调用准确的 `load_skill` 就尝试修改该主文件或其支持文件
- **THEN** 写入前置条件以 `read_before_write_required` 拒绝修改
- **THEN** Curator 完成对应文件的准确读取后才可按既有权限和版本校验重试

#### Scenario: Curator 收到不完整目录

- **WHEN** Curator 可选调用 `skills_list` 并得到 `complete: false`
- **THEN** Curator 不得把未返回条目视为不存在
- **THEN** Curator MAY 缩小筛选范围，或继续仅依据本轮完整候选输入执行不依赖该缺失结论的安全决策
