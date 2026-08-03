## 背景

当前原生 Skill 工具只有 `load_skill` 和 `skill_manage`。`load_skill` 直接返回正文字符串，模型必须先知道准确名称；`skill_manage` 已具备六种动作、权限适配、后台所有权、写入审批、先读后写账本和并发锁。`SkillLibrary.list()`、`SkillLibrary.read()` 与 `SkillLibrary.listSupportFiles()` 已经提供目录、正文和支持文件的统一数据边界，但目录能力尚未暴露为模型工具。

会话启动时，`RuleManager` 会把 Skill 名称和描述冻结到系统提示词快照，以保护提示词缓存。文件变化只刷新 `SkillLibrary` 的实时缓存，不改写活跃会话的系统提示词。因此，冻结的 `<available_skills>` 适合被动匹配，却不能承担活跃会话中的实时目录查询。后台 Review 与复用同一隔离执行器的 Curator 融合 Agent 当前也只看到 `load_skill` 与 `skill_manage`，缺少在创建或选择目标前浏览最新 Skill 集合的低成本入口。

## 目标与非目标

**目标:**

- 形成 `skills_list`、`load_skill`、`skill_manage` 三类清晰职责：目录元数据、完整文件读取、受控写入。
- 让前台模型、后台 Review 与 Curator 融合 Agent 都能从当前 `SkillLibrary` 查询实时目录，而不修改会话系统提示词。
- 让目录工具在统一输出配额内始终返回可解析、可判断完整性的结果，避免后台 Agent 收到不可恢复的折叠输出。
- 让 `load_skill` 返回可机器判断的稳定结构，并列出合法支持文件，避免模型猜测包结构。
- 保持后台修改的准确目标预读、版本摘要校验、权限和所有权保护不变。
- 让工具注册、MCP 命名保护、静态副作用清单和测试契约同步覆盖新工具。

**非目标:**

- 不新增与 `load_skill` 重复的 `skill_view`，也不重命名现有工具。
- 不改变 `skill_manage` 的动作、参数、审批、锁、归档或所有权语义。
- 不用 `skills_list` 替换 `<available_skills>`，不在会话中重建系统提示词或动态增删工具。
- 不为 Skill 内容读取增加分页、偏移或部分读取；模型需要获得完整说明后再执行。
- 不给 `skills_list` 增加 cursor、offset 或 limit 分页；目录过大时只通过分类或关键词缩小匹配集合。
- 不把普通文件、Shell 或 MCP 工具加入后台 Review/Curator 工具面。
- 不改变 Skill 文件布局、frontmatter 或 usage sidecar 格式。

## 架构决策

### 1. 采用三个工具、三个权限与数据边界

原生 Skill 工具固定为：

| 工具 | 职责 | 数据量 | 副作用 |
| --- | --- | --- | --- |
| `skills_list` | 浏览实时目录与筛选候选 | 仅元数据 | 只读，不计查看次数 |
| `load_skill` | 读取一个主文件或支持文件的完整内容 | 单文件正文与包结构 | 只读，成功后计查看次数 |
| `skill_manage` | 创建、修补、替换、删除及维护支持文件 | 写入请求与结果 | 受权限和写入前置条件保护 |

选择独立的 `skills_list`，而不是把无名称调用塞进 `load_skill`，是为了让模型可以先以较低上下文成本发现候选，再只读取必要正文。保留 `load_skill` 名称而不新增 `skill_view`，是因为两者职责相同，重复工具只会增加每次模型请求的 schema 成本和选择歧义。

曾考虑只依赖 `<available_skills>`，但该内容为会话级冻结快照，无法反映同一会话期间的真实新增、删除和覆盖变化；主动重建提示词又会破坏缓存稳定性，因此不采用。

### 2. `SkillLibrary` 是三个工具的唯一数据源

`skills_list` 直接调用当前会话注入的 `SkillLibrary.list()`；`load_skill` 继续通过同一实例执行名称解析、路径校验、读取和查看遥测；`skill_manage` 保持原有写入路径。这样三类工具共享项目覆盖用户、活动索引和 watcher 刷新后的同一视图。

旧 `BuildNativeToolsOptions.loadSkill` 回调只能按名称返回正文，无法提供目录、来源、分类和支持文件，继续保留会产生两套不一致契约。本变更移除该回调及 `LoadSkillTool` 的回退分支，实际装配必须注入 `SkillLibrary`；缺少数据源时 Skill 读写工具明确失败，不静默返回降级结构。

### 3. `skills_list` 返回有界且可判定完整性的目录包络

工具参数包含可选 `category` 与 `query`，并设置 `additionalProperties: false`。两个参数均先去除首尾空白，显式传入空字符串或超过 256 个字符时视为参数错误。`category` 对当前分类做精确匹配；`query` 对名称、描述和分类执行大小写不敏感的子串匹配；同时提供时取交集。

`SkillsListTool` 显式声明 `maxBytes = 256 * 1024`，作为统一输出层的最终保护，而不是“目录一定完整”的依据。工具内部以最终模型可见的 `CallToolResult` 包络（包含外层 JSON 序列化与内层文本转义）不超过 `240 * 1024` UTF-8 字节为目标预算逐项构建结果；每个条目的 `description` 只返回最多 1024 个字符的摘要，发生截断时增加 `descriptionTruncated: true`。条目仍按 `name` 稳定排序。返回 JSON 字符串的逻辑结构为：

```json
{
  "skills": [
    {
      "name": "example",
      "description": "...",
      "descriptionTruncated": true,
      "source": "project",
      "category": "development"
    }
  ],
  "totalCount": 1200,
  "matchedCount": 63,
  "returnedCount": 63,
  "complete": true,
  "filters": {
    "category": "development",
    "query": "typescript"
  }
}
```

`totalCount` 表示筛选前的活动 Skill 数量，`matchedCount` 表示应用筛选后的数量，`returnedCount` 等于本次实际返回的条目数；只有 `returnedCount === matchedCount` 时 `complete` 才为 `true`。未使用筛选时省略 `filters`。未命中时返回空数组、三个正确计数和 `complete: true`，不把合法空结果作为错误。

如果全部匹配项不能在内部预算内安全返回，工具只保留能完整序列化的前缀，返回 `complete: false` 和 `refineHint`，提示模型使用更具体的 `category`/`query` 重试。目录工具、后台读取账本和工具编排器 MUST 复用同一个最终回执序列化函数，保证预算判断与 `ToolDispatcher` 实际接收的字符串逐字节一致；不能依赖折叠结果附带的 `readFile` 路径，因为后台 Skill Agent 并不拥有普通文件工具。该协议不提供分页，也不把不完整结果伪装成完整目录。

没有分类的条目省略 `category`；未截断描述时省略 `descriptionTruncated`。目录不提供正文、物理绝对路径、usage 或所有权内部字段。

### 4. `load_skill` 返回完整文件与包结构的结构化包络

`load_skill` 的参数仍是 `name` 与可选 `file_path`。成功结果改为 JSON 字符串，逻辑结构为：

```json
{
  "name": "example",
  "description": "...",
  "source": "project",
  "category": "development",
  "file": "SKILL.md",
  "content": "完整文件内容",
  "supportFiles": ["references/guide.md", "scripts/check.sh"]
}
```

`file` 使用 `SKILL.md` 或通过现有安全校验的规范化支持文件相对路径，不暴露磁盘绝对路径；`supportFiles` 来自 `SkillLibrary.listSupportFiles()` 并稳定排序。读取支持文件时仍返回同一包络，便于模型继续浏览包结构。缺失的可选分类字段省略。现有名称解析、路径逃逸保护、成功查看遥测和输出上限继续生效。

这是模型工具返回契约的有意不兼容变更。所有内部消费者和测试必须显式解析 JSON 的 `content`，不得继续把整个工具结果当作正文。

### 5. 后台读取账本只记录模型实际看到的 `content`

`BackgroundSkillAgent` 在 `load_skill` 成功且最终 `CallToolResult` 序列化结果不会被统一输出层折叠时，解析结构化包络，并校验包络中的 `name`、`file` 与调用参数一致，再把 `content` 写入 `SkillReviewReadLedger`。配额预测必须使用与工具编排器相同的序列化函数；解析失败、字段不一致、结果被折叠或工具失败时均不签发读取凭证。

`skills_list` 只证明模型看过目录，不证明其看过目标文件；它不得写入读取账本，也不得满足 `skill_manage` 的先读后写要求。已有目标仍必须通过准确的 `load_skill(name[, file_path])` 获取内容摘要；新建 Skill 与新建支持文件继续使用现有不存在性校验。

### 6. 后台 Review 与 Curator 使用一致的三工具边界

`BACKGROUND_SKILL_TOOL_NAMES`、Review 提示词和 Curator 融合提示词同步调整为 `{skills_list, load_skill, skill_manage}`。Review 与 Curator 均通过 `BackgroundSkillReviewService.runIsolatedSkillTask()` 构建同一个 `BackgroundSkillAgent`，因此共享白名单必须与两份提示词一致。有效工具仍是固定集合与父工具面的交集，所有调用仍经过共享 `ToolGateway`、独立权限快照、后台 caller 和禁止人工批准的安全上下文。

Review 提示词要求先用 `skills_list` 获取实时目录，再用 `load_skill` 读取可能承载知识的候选，最后才选择 `skill_manage` 或合法 no-op。如果目录返回 `complete: false`，Review 必须使用更具体的分类或关键词继续筛选；在取得覆盖相关候选的完整结果前，不得据此断言“不存在合适 Skill”或创建新 Skill。该顺序提高复用与去重质量，但不替代写入层的硬性读取凭证和并发版本校验。

Curator 输入已经包含本轮全部可维护候选及其主文件正文，因此 `skills_list` 对 Curator 是用于观察当前 Skill landscape 的可选发现工具，不强制作为每次融合的第一步。`SkillCurator` 同时把冻结的候选名称集合传给 `BackgroundSkillAgent`；后者在进入父 `ToolGateway` 前拒绝针对集合外既有 Skill 的 patch/edit/delete/write_file/remove_file。Curator 本轮成功创建的新 umbrella 加入任务内集合，允许后续维护，但 staged 或失败创建不得扩展范围。由此，目录看到的新条目只能辅助判断，不能依赖提示词服从来扩大权限。修改任何已有主文件或支持文件前仍必须执行准确的 `load_skill`，由读取账本强制先读后写。

### 7. 实时目录不改变提示词缓存边界

`<available_skills>` 继续由 `RuleManager` 在会话创建时冻结，用于模型无需主动调用工具时的快速匹配。`skills_list` 在执行时读取 `SkillLibrary` 实时缓存，因此能看到 watcher 或 `skill_manage` 已确认的变化。调用目录工具不触发 `RuleManager.reloadRules()`、`Context.updateSystemPrompt()` 或历史消息写入。

### 8. 工具注册与命名保护同步更新

`getSkillTools()` 按 `skills_list`、`load_skill`、`skill_manage` 的稳定顺序装配。`skills_list` 作为只读原生工具加入 `EFFECTFUL_ENTRYPOINTS`，无需写入权限适配器；同时加入 MCP 内建名称黑名单，阻止外部 MCP 以同名工具覆盖原生职责。`ToolCatalog` 必须保留工具声明的 `maxBytes`，使 `ToolDispatcher` 使用目录工具的显式配额；现有 `skill_manage` 权限适配器不变。

## 风险与权衡

- [`load_skill` 返回值不兼容] -> 同一变更内迁移后台账本、单元测试、契约测试和集成测试；不提供双格式猜测，避免长期歧义。
- [目录数量无硬上限，任意固定 `maxBytes` 都不能保证全量] -> 工具在内部预算内返回合法 JSON，并以 `complete` 和计数明确披露完整性；模型通过分类/关键词收敛，Review 不得基于不完整结果创建新 Skill。
- [目录较大时增加模型上下文] -> 描述使用有标记的 1024 字符摘要，支持分类和关键词筛选；不返回正文、物理路径或遥测。
- [统一输出层可能折叠大目录且后台无法调用 `readFile`] -> `skills_list` 自身在低于声明 `maxBytes` 的目标预算内构造结果，并在派发前测试实际 UTF-8 大小；不把通用折叠文件当作后台恢复协议。
- [结构化包络增加输出开销，可能触发折叠] -> 保留现有完整性检查；任何可能被折叠的读取都不签发后台写入凭证，安全失败后允许模型缩小目标并重新读取。
- [模型调用 `skills_list` 后误以为可以直接写] -> 提示词明确区分目录浏览与内容读取，运行时继续由读取账本和写入前置条件强制 `load_skill`。
- [实时目录与冻结提示词显示不同] -> 将其定义为有意语义：提示词是会话启动快照，工具是当前事实；工具描述和测试固定这一差异。
- [移除旧回调影响测试辅助代码] -> 迁移到临时目录中的真实 `SkillLibrary`，同时提高测试与生产装配的一致性。

## 迁移计划

1. 定义目录条目、带筛选/计数/完整性状态的目录结果和结构化读取结果类型，增加有界 `skills_list`，并把 `load_skill` 统一到 `SkillLibrary`。
2. 更新原生工具装配、MCP 命名保护和副作用入口清单，确认目录工具在前台目录中可见。
3. 更新后台工具白名单、Review 与 Curator 提示词和读取账本解析，保证结构化结果仍产生准确内容摘要且目录可见性不扩大修改范围。
4. 迁移所有直接消费 `load_skill` 字符串的测试与内部调用，并补齐三工具真实装配、有界实时目录和后台隔离验证。
5. 无持久数据迁移；Skill 包、sidecar、pending 和会话快照保持原格式。

回滚时必须把 `load_skill` 消费方与工具实现一并回滚，避免新消费者读取旧字符串或旧消费者接收新 JSON。由于本变更不迁移持久数据，代码整体回滚即可恢复旧工具契约。

## 待确认问题

无。工具命名、职责边界、有界目录与完整性协议、结构化读取结果和后台使用顺序均已锁定。
