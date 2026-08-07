## 背景

MyAgent 主记忆当前为两层布局：`memoryDir/MEMORY.md`（有界索引）+ `memoryDir/topics/<slug>.md`（主题正文）。加载器（`memory-loader.ts`）通过索引正则 `^- \[([^\]]+)\]\(topics/([^)]+)\)\s*—\s*(.+)$` 解析条目，topic 路径以 `resolve(memoryDir, 'topics', filename)` 定位、以 `resolve(memoryDir, 'topics')` 为越界检查根。Claude Code 的默认/常见形态为平铺（`memoryScan.ts` 递归扫描根下 `.md` 并排除 `MEMORY.md`，提示词示例与用户侧实证目录均为 `MEMORY.md` + 平铺 `<slug>.md`；实现允许嵌套但无引导，属兼容残留），子代理记忆（`agent-memory/<type>/`）内部同样平铺。本次将主记忆对齐官方默认平铺形态，同时保留 MyAgent 更严格的单层契约。

## 目标与非目标

**目标:**
- 主题正文位置从 `memoryDir/topics/<slug>.md` 迁移为 `memoryDir/<slug>.md`，与 `MEMORY.md` 同层。
- 索引条目格式 `- [标题](<slug>.md) — 描述`，加载器正则、路径解析、越界检查根全部平铺化。
- 提示词（`LONG_TERM_MEMORY_RULES`）、记忆投影（assembler）、路径注释（application-paths）零 `topics/` 残留。
- 既有单测与契约测试全量迁移并保持绿色。

**非目标:**
- 不引入官方 recursive 扫描（`readdir({recursive: true})`）——MyAgent 契约维持单层 kebab-case 文件名，仅去掉 `topics/` 中间层。
- 不提供存量数据迁移工具（当前 `~/.myagent/projects/<key>/memory/` 无 topics 存量；有存量时 `mv topics/*.md .` 一行命令即可，非代码契约）。
- 不改变 `memoryDir` 位置、快照语义（有界读取/截断/冻结/刷新边界）、四类型、容量上限、`.candidates/` 候选暂存与既有权限模型的其他语义（保留名 deny 为本次新增的确定性保护，属设计目标而非既有语义的变更）。
- 不涉及子代理记忆（独立 change）。

## 架构决策

**决策 1：主题正文与 `MEMORY.md` 同层平铺（`memoryDir/<slug>.md`）**
对齐官方主记忆形态与子代理记忆内部形态，统一文件契约心智。索引链接相对路径直接指向同层文件，无需中间层。
替代方案：保持 `topics/` 仅改措辞——被否决，未解决布局不一致问题。

**决策 2：索引条目正则去掉 `topics/` 前缀捕获，改为 `^- \[([^\]]+)\]\(([^)]+\.md)\)\s*—\s*(.+)$`**
文件名捕获后仍执行 kebab-case 单层校验（现有 `KEBAB_CASE_RE`），`/`、`\`、`..` 等路径分隔符自然被拒绝，路径穿越面不因平铺而扩大。旧格式条目 `topics/foo.md` 含 `/` 不匹配 kebab-case，自动失效（fail-closed），测试显式断言其不再进入主题列表。
替代方案：接受任意路径形态（含嵌套子目录）——被否决，与"单层 kebab-case"既有契约冲突，也与官方仅默认平铺（嵌套为无引导的兼容残留）的定位不符。

**决策 3：越界检查根从 `resolve(memoryDir, 'topics')` 收紧为 `resolve(memoryDir)`**
诊断阶段（`diagnoseMemoryTopics`）只接受 `memoryDir` 根下的单层文件；`topics/` 目录不复存在，`isPathInside(resolve(memoryDir), topicPath)` 直接判定。`memoryDir` 根即权限边界，语义更直观。
替代方案：保留 `topics/` 目录但仅索引同层——无意义，平铺后该目录不再创建。

**决策 4：措辞全量替换，不留兼容分支**
`prompts.ts`（4 处：目录说明、frontmatter 写入位置、索引示例、创建前列举/忘记删除路径）、`model-request-assembler.ts`（2 处：投影前导、空索引提示）、`application-paths.ts`（注释）一次性替换为平铺表述。不留"topics/ 或根下"双路径描述，避免模型困惑。
替代方案：措辞双轨兼容——被否决，平铺是唯一真实布局，双轨描述徒增歧义。

**决策 5：`.candidates/` 隐藏目录保留不动**
候选暂存（`MemoryCandidateStore`）与主题正文语义不同、不被投影读取，不属于"记忆布局"范畴。

**决策 6：`memory.md` 定义为保留文件名，三层防护（P1）**
Windows 等大小写不敏感文件系统上，`memory.md` 与索引 `MEMORY.md` 是同一文件；模型把它当主题名创建会直接覆盖索引。三层防护：
1. **提示词层**：`LONG_TERM_MEMORY_RULES` 显式声明 `memory.md`（大小写不敏感）为保留名，禁止用作主题文件名。
2. **加载器层（fail-closed）**：`loadMemorySnapshot`/`diagnoseMemoryTopics` 对 slug 大小写折叠后等于 `memory` 的文件名记为 `invalidFilenames`，不作为主题。
3. **权限层（确定性保护）**：共享判定 `isReservedMemoryWriteTarget(targetPath, memoryRoot)` **先限定目标位于当前记忆根内**（默认或自定义根），再对 basename 大小写折叠后等于 `memory.md` **且原形字符串不等于 `MEMORY.md`** 的目标返回 `deny`（而非 allow/ask）。记忆根外的目标（工作区普通目录的 memory.md）不拦截；未启用 Auto Memory（根为 null）时不拦截。四个写类工具 `checkPermissions`（WriteFileTool/EditFileTool/CreateDirectoryTool/ApplyPatchTool）与 `checkMemoryPermission` 共用该判定。原形 `MEMORY.md` 是索引更新的合法目标，必须继续 allow——两类操作在文件系统上指向同一文件，但路径字符串可区分：模型写索引用 `MEMORY.md` 原形，意图建主题才可能写出 `memory.md` 变体。
替代方案：仅提示词与加载器两层——被否决，模型不遵守提示词时仍可覆盖索引，需确定性边界。仅按 basename 判定不限定记忆根——被否决，会误伤工作区普通 memory.md 文件。

## 风险与权衡

- [机械替换面广（9 个测试文件 + 1 个 fixture）] -> 全部为索引字符串与目录构造替换，改动前用 Grep 全量清点 `topics/` 字面量引用（领域标识 `topics` 字段、`diagnoseMemoryTopics` 等名称不在替换范围），apply 后以 `topics/` 字面量复查零残留。
- [索引格式变化破坏既有记忆目录兼容（BREAKING）] -> 当前无 topics 存量数据，无迁移成本；契约测试同步更新为新格式并新增「旧 `topics/` 条目被拒绝」断言，防止回归。
- [保留名权限 deny 误伤索引更新] -> deny 判定显式排除原形 `MEMORY.md`（大小写敏感比较），索引更新路径不受影响；测试覆盖「写 `MEMORY.md` 允许、写 `memory.md` 拒绝」。
- [保留名判定误伤工作区普通 memory.md 文件] -> 共享判定先以记忆根限定路径范围（`isPathInside(memoryRoot, target)`），根外目标不拦截、未启用记忆时不拦截；测试覆盖「工作区 docs/memory.md 不受影响」「自定义根内拒绝」「未启用不生效」。
- [越界检查根收紧可能拒绝合法路径] -> 平铺后合法路径只有 `memoryDir/<slug>.md` 一种，收紧即精确，无合法路径被误伤。

## 迁移计划

无数据迁移（无存量）。回滚：`git` 回滚本 change 即可恢复两层布局（正则、路径、措辞同步回滚，无中间态）。
