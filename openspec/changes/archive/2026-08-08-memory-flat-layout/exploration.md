# 探索：主记忆布局平铺化（memory-flat-layout）

## 目标

将 MyAgent 项目长期记忆的文件布局从「MEMORY.md 索引 + topics/ 子目录主题正文」改为 Claude Code 官方形态的平铺结构：`memoryDir/` 根下直接存放 `MEMORY.md` 与 `<slug>.md`。纯内部重构，不改变任何能力、路径与快照语义。

## 官方事实（源码核实）

- **官方默认/引导形态为平铺**：提示词写入示例全部为根下文件名（`buildMemoryLines` memdir.ts:223、`buildExtractAutoOnlyPrompt` extractMemories/prompts.ts:72 均为 `user_role.md` 等），索引示例 `- [Title](file.md) — one-line hook`；用户自己的 Claude Code 记忆目录（`~/.claude/projects/<project>/memory/`）即平铺：`MEMORY.md` 索引 + 同层 `<slug>.md`。
- **官方实现允许嵌套**：`scanMemoryFiles`（memoryScan.ts:40）以 `readdir(memoryDir, { recursive: true })` 递归扫描并排除 `MEMORY.md`，`MemoryHeader.filename` 为相对路径（可含子目录），`findRelevantMemories`（findRelevantMemories.ts:59）按该相对路径匹配召回。嵌套无提示词引导，属实现兼容残留，非推荐形态。
- **子代理记忆**（`src/tools/AgentTool/agentMemory.ts`，上阶段已核实）：`agent-memory/<type>/` 目录内同样为 MEMORY.md + 平铺 md。
- **结论表述**：MyAgent 对齐官方**默认/常见平铺形态**，同时保留更严格的**单层文件契约**（拒绝嵌套），而非声称官方只支持平铺或存在"统一文件契约"。

## MyAgent 现状

| 元素 | 现状 |
|---|---|
| 索引 | `memoryDir/MEMORY.md`，条目正则 `- [标题](topics/<slug>.md) — 描述`（memory-loader.ts:29） |
| 正文 | `memoryDir/topics/<slug>.md`（memory-loader.ts:295 解析、:296 越界检查根） |
| 候选暂存 | `memoryDir/.candidates/*.json`（不投影，保留不动） |

## 改动面（已全量清点）

**源码（5 处）**：
1. `src/core/usecases/brain/memory-loader.ts`：`INDEX_ENTRY_RE` 去掉 `topics/` 前缀捕获；topic 路径解析 `resolve(memoryDir, 'topics', filename)` → `resolve(memoryDir, filename)`；越界检查根 `resolve(memoryDir, 'topics')` → `resolve(memoryDir)`；相关注释（28/29/141/295/296 行）。
2. `src/core/usecases/brain/prompts.ts`：`LONG_TERM_MEMORY_RULES` 4 处 `topics/` 措辞（16/42/59/66/75 行）改为平铺文件名。
3. `src/core/usecases/engine/model-request-assembler.ts`：404 行「不要把 topics/ 相对路径解析到工作区」、425 行「创建 MEMORY.md 和 topics/*.md」措辞。
4. `src/config/application-paths.ts:96`：注释「以 MEMORY.md 为索引、topics/*.md 为主题正文」。
5. （fixture）`test/fixtures/permissions/claude/index.json`：两处 `memory/topics/...` 样本路径。

**测试（8 个文件）**：contract/long-term-memory.test.ts、core/usecases/brain/memory-loader.test.ts、auto-memory-agent.test.ts、memory-permissions.test.ts、core/usecases/engine/model-request-assembler.test.ts、SessionManager.test.ts、adapters/input/interface/commands/memory.test.ts、adapters/tools/tools.test.ts——索引字符串与目录构造改平铺。

## 边界与非目标

- `.candidates/` 隐藏目录保留不动（官方无对应物，属 MyAgent 候选暂存，不被投影读取）。
- `memoryDir` 位置、快照语义（有界读取/截断/不可变冻结）、四种类型、容量上限均不变。
- 不做「官方 recursive 扫描」——MyAgent 契约维持单层 kebab-case 文件名，仅去掉 topics/ 中间层。
- 不引入迁移工具：MyAgent 用户目录当前无 topics 存量数据（本仓库运行数据在 `~/.myagent/projects/<key>/memory/`，未见历史数据依赖）；无存量即无需迁移。若有存量仅需 `mv topics/*.md .`，不属代码契约。

## 结论

方案唯一、目标明确、无开放问题，达到 propose 条件。验收门槛：索引正则与路径解析全部平铺化、措辞零残留 `topics/`、全部既有单测与契约测试绿色。
