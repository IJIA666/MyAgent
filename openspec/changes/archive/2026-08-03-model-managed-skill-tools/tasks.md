## 1. 定义目录与结构化读取契约

- [x] 1.1 在 `src/core/usecases/brain/skill-types.ts` 增加只读的 `SkillListItem`、`SkillListFilters`、`SkillListResult` 与 `SkillReadResult` 类型：目录条目限定 `name/description/descriptionTruncated?/source/category?`；目录结果限定 `skills/totalCount/matchedCount/returnedCount/complete/filters?/refineHint?`；读取结果限定 `name/description/source/category?/file/content/supportFiles`；任何结果不得暴露 `filePath`、`skillDir`、usage 或所有权字段。
- [x] 1.2 新建 `src/adapters/tools/impl/skill/skills-list.ts` 实现只读 `SkillsListTool`：schema 只接受最大 256 字符的可选 `category`/`query` 且 `additionalProperties=false`，去除首尾空白后拒绝显式空值；分类按原始元数据精确匹配，关键词对原始名称、描述和分类做大小写不敏感的子串匹配；从注入的 `SkillLibrary.list()` 读取当前合并活动视图并按名称排序。类声明 `maxBytes = 256 * 1024`，按最多 1024 字符的描述摘要逐项构造最终模型可见 `CallToolResult` 不超过 `240 * 1024` UTF-8 字节的合法 JSON 包络；完整时返回 `complete=true`，超预算时返回正确的三类计数、`complete=false` 和 `refineHint`，不得依赖统一输出层的折叠文件恢复；空结果正常返回且不得调用 `recordView`。
- [x] 1.3 修改 `src/adapters/tools/impl/skill/skill.ts`：移除旧正文回调分支，要求以 `SkillLibrary` 完成名称解析和安全读取；把成功结果改为 `SkillReadResult` JSON 字符串，`file` 使用 `SKILL.md` 或已校验的相对支持文件路径，`supportFiles` 使用 `listSupportFiles()` 的完整排序结果，继续只在成功读取后记录一次 view telemetry。
- [x] 1.4 扩充 `test/adapters/tools/skill-tools.test.ts`：覆盖项目同名覆盖用户、稳定排序、分类与大小写不敏感关键词的交集筛选、空值/超长/未知参数拒绝、合法空结果、长描述摘要标记、目录不增加 viewCount，以及普通和大量需二次 JSON 转义的超大目录均返回最终配额内合法结果、正确计数、`complete=false/refineHint`；同时覆盖结构化主文件与支持文件结果、非法路径、缺少 SkillLibrary 明确失败，以及读取工具不提供 offset/limit。

<!-- checkpoint: npx vitest run test/adapters/tools/skill-tools.test.ts test/core/usecases/brain/skill-library.test.ts -->

## 2. 统一装配并保护三工具边界

- [x] 2.1 修改 `src/adapters/tools/impl/skill/index.ts` 与 `src/adapters/tools/tool-factory.ts`：移除 `loadSkill` 回调参数和 `BuildNativeToolsOptions.loadSkill`，统一传入同一个 `SkillLibrary`，并按 `skills_list`、`load_skill`、`skill_manage` 顺序构建工具；缺少数据源时保持工具可诊断失败，不生成伪造目录。
- [x] 2.2 修改 `src/adapters/tools/effectful-entrypoints.ts`，把 `skills_list` 登记为 `read` 原生入口且不配置写权限适配器；修改 `src/adapters/tools/mcp-client.ts`，把 `skills_list` 加入内建工具冲突黑名单，阻止外部 MCP 覆盖。
- [x] 2.3 更新 `test/contract/agent-managed-skills.test.ts`，从真实 `getSkillTools`/`buildNativeTools` 装配断言三工具名称、顺序、安全类别、schema 和 `skills_list.maxBytes`；更新 `test/contract/effectful-entrypoint-coverage.test.ts` 与 `test/adapters/tools/mcp-client.test.ts`，验证只读入口清单和同名 MCP 冲突行为。
- [x] 2.4 更新 `src/core/usecases/engine/ToolDispatcher.ts` 与 `tool-call-orchestrator.ts`，集中定义最终模型回执序列化函数；更新 `test/core/usecases/engine/ToolDispatcher.test.ts`，以经过真实 `CallToolResult` 包装、超过默认 50KB 但低于声明配额的目录结果验证 `ToolCatalog` 保留 `maxBytes`、`ToolDispatcher` 原样返回且不生成通用折叠提示或恢复文件；保留其他超限工具仍走既有统一折叠路径的回归断言。

<!-- checkpoint: npx vitest run test/contract/agent-managed-skills.test.ts test/contract/effectful-entrypoint-coverage.test.ts test/adapters/tools/mcp-client.test.ts test/core/usecases/engine/ToolDispatcher.test.ts -->

## 3. 迁移后台 Review 与 Curator 的目录读取写入链路

- [x] 3.1 修改 `src/core/usecases/brain/background-skill-agent.ts`：固定工具上限扩为 `skills_list/load_skill/skill_manage`；`skills_list` 成功结果只透传且绝不写入 `SkillReviewReadLedger`；`load_skill` 成功后先确认模型可见输出未被折叠，再解析 JSON 并校验 `name`、`file` 与调用参数一致，仅以 `content` 原文记录摘要，解析失败、字段错配、取消或工具失败均 fail closed。
- [x] 3.2 同步修改 `src/core/usecases/brain/background-skill-review.ts` 与 `src/core/usecases/brain/skill-curator-prompt.ts`：Review 必须先用 `skills_list` 查看实时目录，遇到 `complete=false` 时用分类/关键词收敛，并在取得相关完整结果前禁止断言无候选或创建 Skill；两者均明确目录查看不能替代已有目标及支持文件的准确预读。Curator 提示必须说明 `skills_list` 可选用于发现当前 landscape，但候选输入仍是可修改已有 Skill 的边界，目录不得扩大 ownership、pinned、项目来源或本轮候选范围。
- [x] 3.3 更新 `test/core/usecases/brain/background-skill-agent.test.ts`：断言只暴露三工具、拒绝 Shell 等其他工具、目录调用不产生读取凭证、结构化 `content` 生成正确摘要，以及旧纯字符串、字段错配、输出折叠和失败结果均不签发凭证。
- [x] 3.4 更新 `test/core/usecases/brain/background-skill-review.test.ts` 与 `test/contract/background-skill-learning.test.ts`：断言 Review 提示词中的目录—完整性收敛—读取—写入顺序和三工具固定上限，保留只有真实 `skill_manage success/staged` 才产生变更通知的契约；更新 `test/contract/skill-curation.test.ts` 与 `test/core/usecases/brain/skill-curator-consolidation.test.ts`，断言 Curator 也只看到三工具、提示与白名单一致、目录发现不扩大候选修改范围，且输入正文不能替代准确 `load_skill` 凭证。
- [x] 3.5 更新 `test/integration/background-skill-isolation.test.ts` 的真实模型请求断言：后台只看到 `skills_list/load_skill/skill_manage`，父历史与主会话快照仍隔离，新增目录工具不得带入普通文件、Shell、Browser、MCP 或交互能力。
- [x] 3.6 在 `IsolatedSkillTaskRequest`、`SkillCurator` 与 `BackgroundSkillAgent` 之间传递冻结的 Curator 候选名称集合：在父 `ToolGateway` 前拒绝修改集合外既有 Skill；仅把同一任务真实 `success` 的 create 目标加入集合，失败或 staged 不扩展范围。补充越界拒绝、新 umbrella 后续维护及候选集合装配测试。

<!-- checkpoint: npx vitest run test/core/usecases/brain/background-skill-agent.test.ts test/core/usecases/brain/background-skill-review.test.ts test/contract/background-skill-learning.test.ts test/contract/skill-curation.test.ts test/core/usecases/brain/skill-curator-consolidation.test.ts test/integration/background-skill-isolation.test.ts -->

## 4. 固定提示词快照与实时目录的并存行为

- [x] 4.1 在 `test/core/usecases/brain/RuleManager.test.ts` 使用同一个实时 `SkillLibrary` 验证：会话快照建立后新增、删除或项目覆盖 Skill，`skills_list` 能看到最新合并目录，而 `RuleManager` 已冻结的 `<available_skills>` 内容、系统消息和提示词哈希均不改变。
- [x] 4.2 在 `test/contract/agent-managed-skills.test.ts` 增加真实链路场景：前台通过 `skill_manage(create)` 成功创建后，同一会话的 `skills_list` 和 `load_skill` 立即可见，现有提示词快照不作为实时目录数据源；pending 或失败写入不得提前出现在目录中。
- [x] 4.3 核对 `src/core/usecases/brain/RuleManager.ts` 与 `src/core/usecases/brain/prompts.ts`：保留 `<available_skills>` 启动快照和现有自动匹配，不把 `skills_list` 结果写回 Context，不为实时目录调用 `reloadRules()` 或 `updateSystemPrompt()`；仅在需要时补充解释三种工具职责的稳定提示文本。

<!-- checkpoint: npx vitest run test/core/usecases/brain/RuleManager.test.ts test/contract/agent-managed-skills.test.ts -->

## 5. 完成不兼容迁移与整体验证

- [x] 5.1 全仓检索 `loadSkill`、`new LoadSkillTool`、`load_skill` 返回值消费点和只含两工具的固定断言，迁移实际依赖方到 `SkillReadResult.content`；显式迁移 `test/integration/skill-learning-loop.test.ts` 当前约第 97、157 行的两个 `new LoadSkillTool(undefined, library)` 真实消费者，改为统一 `SkillLibrary` 构造并解析 JSON 的 `content`，不得继续用 `toContain` 把整个返回值当正文；删除旧回调类型、构造参数和纯字符串结果假设，保留 `SkillLearningPlugin` 等只观察工具名称而不消费正文的路径不变。
- [x] 5.2 核对新增及修改的公开类型、类、构造函数和方法均使用项目要求的 TSDoc，工具 schema 与 TypeScript 结果类型字段一致，`skill_manage` 六动作、权限适配、后台所有权、写入审批、先读后写与锁实现没有被旁路或改写。
- [x] 5.3 运行 Skill 相关单元、契约和必要的后台隔离/学习循环集成测试，确认结构化读取、有界实时目录、目录完整性收敛、提示词缓存、Review/Curator 权限边界同时成立；只修正新契约下的断言，不保留旧纯字符串兼容分支。

<!-- checkpoint: npx vitest run test/adapters/tools/skill-tools.test.ts test/contract/agent-managed-skills.test.ts test/core/usecases/engine/ToolDispatcher.test.ts test/core/usecases/brain/background-skill-agent.test.ts test/core/usecases/brain/background-skill-review.test.ts test/contract/background-skill-learning.test.ts test/contract/skill-curation.test.ts test/core/usecases/brain/skill-curator-consolidation.test.ts test/integration/background-skill-isolation.test.ts test/integration/skill-learning-loop.test.ts test/core/usecases/brain/RuleManager.test.ts -->
<!-- checkpoint: npm run test:typecheck -->
<!-- checkpoint: npm run lint -->
<!-- checkpoint: npm run build -->
<!-- checkpoint: npx openspec validate model-managed-skill-tools --type change --strict -->
