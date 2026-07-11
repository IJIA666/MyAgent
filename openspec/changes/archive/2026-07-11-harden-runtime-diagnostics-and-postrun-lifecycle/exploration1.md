# 探索主题：通用只读工具增强与 Plan 模式诊断边界

## 1. 问题定义

当前仓库在诊断类任务上同时存在两类约束：

1. `Plan` 模式对终端命令采取强约束，只允许可静态证明安全的只读原子命令进入审批流，不满足条件的命令会被 `BLOCKED (Plan Mode Only)` 直接拒绝。
2. 仓库内置的通用只读工具（尤其是 `listFiles`、`readFile`）信息量偏低，难以在不借助命令行的前提下支撑“测量级”诊断结论。

这导致类似“磁盘空间是谁占用”“目录下哪些文件最大”“某个候选目录是否值得继续下钻”这类问题，虽然有通用工具可用，但往往只能得到枚举级信息，无法稳定得到带大小、更新时间、层级规模的测量结果。

本探索只讨论以下边界：

- 通用只读文件工具是否足以承担诊断职责
- `Plan` 模式下终端诊断能力与通用工具之间的职责分配
- 若未来增强递归能力，当前护栏是否足够

本探索不讨论以下边界：

- 终端审批体系总体重构
- 写命令授权策略调整
- 新增专用磁盘诊断工具

## 2. 代码现状

### 2.1 `listFiles` 目前仅提供浅层枚举

`ListFilesTool` 当前只对目标目录执行一层 `readdirSync`，最终返回纯文件名数组，不带大小、类型、更新时间，也不递归：

- `src/adapters/tools/impl/filesystem/file-system.ts:529`
- `src/adapters/tools/impl/filesystem/file-system.ts:585`
- `src/adapters/tools/impl/filesystem/file-system.ts:586`

这意味着它本质上只能回答“这里有什么名字”，不能回答“哪个条目更大、更新、是否值得深入”。

### 2.2 `readFile` 内部已有文件状态读取，但结果不暴露元数据

`ReadFileTool` 在执行时会先调用 `statSync(safePath)` 做目录/文件判定，也会记录 `mtimeMs` 用于去重缓存：

- `src/adapters/tools/impl/filesystem/file-system.ts:133`
- `src/adapters/tools/impl/filesystem/file-system.ts:178`

但最终返回值仍然只有正文或选定行范围内容：

- `src/adapters/tools/impl/filesystem/file-system.ts:153`
- `src/adapters/tools/impl/filesystem/file-system.ts:157`
- `src/adapters/tools/impl/filesystem/file-system.ts:179`

换句话说，工具内部已经拿到了部分元数据，但没有对大模型暴露这些信息。

### 2.3 诊断护栏目前更偏向“限制扩散”，不是“支撑测量”

诊断护栏对 `listFiles` 的治理方式是：

- 每轮最多枚举 4 次：`DIAGNOSTIC_LISTFILES_BUDGET = 4`
- 连续重复低价值枚举 2 次后阻断
- `listFiles` 结果最多只能把证据等级提升到 `enumeration`
- `measured` 证据目前只从 `execute_command` 的输出中识别

对应实现：

- `src/core/domain/diagnostic-guardrails.ts:9`
- `src/core/domain/diagnostic-guardrails.ts:11`
- `src/core/domain/diagnostic-guardrails.ts:115`
- `src/core/domain/diagnostic-guardrails.ts:130`
- `src/core/domain/diagnostic-guardrails.ts:179`
- `src/core/domain/diagnostic-guardrails.ts:203`
- `src/core/domain/diagnostic-guardrails.ts:212`

这说明当前护栏的主要目标是防止模型无边界扩散扫描，而不是帮助通用只读工具产出足够强的诊断证据。

### 2.4 `Plan` 模式允许的终端诊断能力是“窄而原子”的

`execute_command` 在 `Plan` 模式下并非完全禁用，而是先通过 `isPlanSafeCommand(...)` 做同构安全判定：

- 命中只读白名单
- 不包含复合连接、重定向、环境变量展开、命令替换
- 不属于高危命令

满足条件的命令进入统一审批流，否则直接 `deny`：

- `src/adapters/tools/impl/system/terminal.ts:122`
- `src/adapters/tools/impl/system/terminal.ts:126`
- `src/adapters/tools/impl/system/terminal.ts:131`
- `src/adapters/tools/impl/system/terminal.ts:134`
- `src/adapters/tools/impl/system/terminal-guard.ts:349`

测试也明确表明，`Get-PSDrive C`、特定格式的 `wmic logicaldisk ... get ...` 这类原子只读命令可进入 `Plan` 审批，但带 `|`、`>`、`;` 的复合命令会被直接拒绝：

- `test/adapters/tools/terminal.test.ts:293`
- `test/adapters/tools/terminal.test.ts:294`
- `test/adapters/tools/terminal.test.ts:304`
- `test/adapters/tools/terminal.test.ts:305`
- `test/adapters/tools/terminal.test.ts:306`
- `test/adapters/tools/terminal.test.ts:451`

## 3. 本次结论

### 3.1 单靠当前 `listFiles` / `readFile`，不足以支撑这类诊断任务

这不是“模型不会用通用工具”，而是“当前通用工具给的信息天然不够”。

在当前实现下：

- `listFiles` 只能给名字列表
- `readFile` 只能给正文，不给文件体积、更新时间、总行数等元数据
- 护栏又只把这些结果记成 `enumeration`

因此模型很难仅凭通用工具得出“已确认主要占用项”这类测量级结论。

### 3.2 方向应当是增强通用只读工具，而不是优先新增专用诊断工具

对于这类问题，更合理的方向不是马上新增 `getVolumeInfo`、`measureDirectory` 之类专用工具，而是先把通用只读工具做厚：

- `listFiles` 返回每个直接子项的基础元数据
- `readFile` 返回正文同时附带文件元数据
- 让大模型在更多场景下先用“结构化只读工具”完成诊断，而不是一上来依赖终端

这样既保持工具集的通用性，也更符合 `Plan` 模式下“优先只读原生工具”的设计方向。

### 3.3 不建议把 `Plan` 模式放宽到任意复合命令

虽然当前 `Plan` 模式对诊断命令的限制偏严，但这不意味着应当放开任意复合命令。

原因很直接：

- 管道、重定向、变量展开、嵌套 shell 会显著抬高静态审核成本
- 当前实现强调“前置判定与执行期同构”，就是为了避免“审批看起来安全，执行时语义漂移”
- 一旦允许任意复合命令，审批对象就从“一个原子动作”退化成“一段脚本”

因此更稳妥的方向是：

- 扩大可审批的原子只读命令范围
- 增强通用只读工具的信息密度
- 而不是直接依赖人工审批兜底任意复合 shell

## 4. 关于递归：当前处理是否足够

### 4.1 对“当前无递归实现”来说，现有处理基本够用

由于 `listFiles` 现在根本不递归，当前护栏只按“调用次数”约束枚举扩散，基本能防止模型不停地浅层乱扫：

- `listFiles` 预算 4 次
- 重复低价值扫描达到 2 次阻断
- 大输出有统一截断和落盘机制

对应实现：

- `src/core/domain/diagnostic-guardrails.ts:115`
- `src/core/domain/diagnostic-guardrails.ts:130`
- `src/core/usecases/engine/ToolDispatcher.ts:34`

所以对“当前只列一层目录”的版本，现有治理是够的。

### 4.2 一旦未来增强递归能力，当前处理明显不够

如果将来把 `listFiles` 增强为可递归列目录，当前仅靠“调用次数预算”的治理方式会立刻失效。原因是模型完全可以把“4 次浅层枚举”绕成“1 次深度递归扫描整棵树”。

递归场景下需要治理的不再只是“调用次数”，而是：

- 递归深度 `maxDepth`
- 访问节点数 `maxEntries`
- 返回体积 `maxBytes`
- 默认排除目录 `excludeDirs`
- 结果是否截断 `isTruncated`

仓库里其实已经存在可复用的“递归扫描 + limit + truncated”模式，主要体现在 `search` 工具和 `ToolDispatcher` 上：

- `src/adapters/tools/impl/filesystem/search.ts:60`
- `src/adapters/tools/impl/filesystem/search.ts:229`
- `src/adapters/tools/impl/filesystem/search.ts:326`
- `src/adapters/tools/impl/filesystem/search.ts:333`
- `src/core/usecases/engine/ToolDispatcher.ts:40`
- `src/core/usecases/engine/ToolDispatcher.ts:41`
- `src/core/usecases/engine/ToolDispatcher.ts:52`
- `src/core/usecases/engine/ToolDispatcher.ts:93`

结论是：如果未来确实要给通用只读工具加递归能力，应当复用这套“显式限制 + 截断标志 + 提示语”的治理方式，而不是只靠现有的 `listFilesUsed` 计数。

## 5. 推荐方向

### 5.1 通用只读工具增强优先级

推荐优先增强通用只读工具，而不是优先扩展 `Plan` 终端能力：

1. `listFiles` 增强为“默认简洁、按需带统计”的双模式：
   - `name`
   - `path`
   - `kind`
   - `isDirectory`
   - 可选 `sizeBytes`
   - 可选 `mtimeMs`

   说明：
   - 默认输出仍应以低噪声为主，避免影响常规编码浏览体验
   - 对目录项不应默认计算聚合大小；若返回 `sizeBytes`，目录建议先返回 `null` 或“条目自身 stat 值”，避免隐式触发重型递归统计

2. `readFile` 增强为“正文优先、元数据分离”的结构：
   - 正文内容保持主位
   - 可选 `sizeBytes`
   - 可选 `mtimeMs`
   - 可选 `lineCount`

   说明：
   - 元数据应位于独立字段，而不是混入正文，避免破坏现有阅读心智
   - 常规编码读取不应被过多文件系统细节淹没

3. 诊断护栏同步更新：
   - 让结构化只读工具输出也有机会提升到 `measured`
   - 不再把测量级证据几乎完全绑定到 `execute_command`
   - 但 `measured` 的提升应只在输出确实包含与任务相关的数量型证据时触发，不能因存在 `mtime` 一类辅助元数据就自动升级

### 5.2 递归增强的治理原则

如果后续要在通用工具里引入递归，建议遵守以下原则：

- 默认不递归
- 只有显式参数时才递归
- 必须带 `maxDepth`、`maxEntries`、`maxBytes`
- 返回值必须显式给出 `isTruncated` 与 `notice`
- 护栏按“扫描规模”而不是“调用次数”治理

### 5.3 元数据获取策略：优先内建到通用工具，命令只做补位

对于“文件大小、修改时间、目录项类型”这类文件系统元数据，推荐顺序应当是：

1. **优先由通用只读工具内部直接获取**  
   也就是在 `listFiles` / `readFile` 的实现内部，通过文件系统 API 读取 `stat` / `mtime` / `dirent`，再以结构化字段按需返回，而不是让模型先列目录、再自己拼命令补查。

2. **只有当元数据天然不属于文件树对象时，才考虑命令补位**  
   例如卷级可用空间、挂载点、文件系统类型，这类信息不是单个文件或目录的自然属性，更适合作为 `Plan` 下可审批的原子只读命令，或后续单独抽象为更高层的系统读取能力。

3. **只有在跨任务反复出现、且无法自然挂靠到现有通用工具时，才考虑新增专用工具**  
   否则很容易把“通用工具信息密度不足”的问题，误修成“不断堆新工具”。

进一步拆开看：

- `readFile` 的元数据最容易做，因为当前实现内部本来就已经拿到了 `statSync(...).mtimeMs`。这类信息应优先通过现有工具结果的独立字段暴露，而不是再走 shell。
- `listFiles` 的直接子项元数据也适合内建获取。合理做法是保持默认轻量输出，再提供显式开关按需附带 `sizeBytes`、`mtimeMs`、`kind`。
- 目录聚合体积不是同一层问题。它本质上已经从“读取目录项元数据”升级成“受限递归统计”，不应伪装成普通 `listFiles` 的默认行为。若确有需要，应显式参数开启，并复用递归限制、截断标志和提示语。
- 卷级或系统级元数据仍可保留命令路径，但前提是命令必须保持 `Plan` 可审核的原子只读形态，不能为了拿一个数值就放开复合命令。

竞品调研也支持这个判断：

- **OpenCode** 在 `list` 内部逐项 `stat`，但默认只返回 `path/type`，说明“内部获取、外部克制暴露”是可行路径。
- **OpenClaw** 的 `ls` 也是内部 `stat` 后只用来判断目录后缀，并不要求模型自行补命令。
- **Hermes Agent** 虽然会在 `read_file` 里返回 `file_size`，但它大量文件能力本来就是 shell 封装；这恰好说明，一旦把元数据获取过度外包给命令，安全、可审计性和输出稳定性都会变差。

## 6. 否决方向

- **为本次问题直接新增专用磁盘诊断工具**：会掩盖通用只读工具本身信息密度不足的根因，不应作为第一步。
- **在 `Plan` 模式下放开任意复合命令并依赖审批兜底**：审批对象退化为脚本段，静态可验证性明显下降，不符合当前安全边界。
- **直接给 `listFiles` 开无限递归**：会绕过现有按调用次数治理的设计，极易把浅层枚举升级成单次重型扫描。

## 7. 竞品调研分析（2026-07-11）

### 7.1 调研范围

对四个主要竞品/参考项目进行了深度源码调研：

| 项目 | 类型 | 路径 |
|------|------|------|
| **Claude Code** | 编码专用 Agent | `D:\projects\Agents\claude-code-analysis` |
| **OpenCode** | 编码专用 Agent | `D:\projects\Agents\opencode` |
| **OpenClaw** | 通用 Agent | `D:\projects\Agents\openclaw` |
| **Hermes Agent** | 通用 Agent | `D:\projects\Agents\hermes-agent` |

### 7.2 listFiles/readDir 竞品对比

**核心发现：四个竞品在目录列举工具中均不返回文件大小（size）或修改时间（mtime）。**

| 维度 | Claude Code | OpenCode | OpenClaw | Hermes Agent |
|------|------------|---------|---------|-------------|
| 专用 listFiles 工具 | ❌ 无，靠 GlobTool 替代 | ✅ `list` 工具 | ✅ `ls` 工具 | ❌ 无，靠 `search_files target=files` |
| 返回是否含 `size` | N/A | ❌ 仅 `path+type` | ❌ 仅文件名 | ❌ 仅路径字符串 |
| 返回是否含 `mtime` | N/A | ❌ | ❌ | ❌（内部按 mtime 排序但不暴露） |
| 返回是否含 `isDirectory` | ❌ | ✅ `type` 字段 | ✅ 目录名加 `/` 后缀 | ❌ 只返回文件 |
| 分页 / 截断 | Glob: limit=100, `truncated` | limit=2000, offset 分页 | limit=500, 字节截断 | limit=50, offset 分页 |
| 递归支持 | ✅ Glob 默认递归 | ❌ `list` 不递归 | ❌ `ls` 不递归 | ✅ 始终递归（无深度限制） |

**分析结论：**

本探索推荐的增强方向——给 `listFiles` 返回 size、mtime、isDirectory 等元数据——在竞品中无先例。这意味着我们的实现一旦落地，将是行业首个在通用目录列举工具中暴露测量级元数据的方案，形成明显的差异化优势。

具体参考：

- **OpenCode** 的 `list`（`packages/core/src/tool/read-filesystem.ts:324-352`）返回 `ListPage` 对象，其中 `entries` 仅含 `path` + `type`，按目录优先+字母序排列。核心层以 `MAX_READ_LINES = 2000` 为截断上限，TUI 层仅返回纯字符串列表（`packages/opencode/src/tool/read.ts:101-115`）。
- **OpenClaw** 的 `ls`（`src/agents/sessions/tools/ls.ts`）使用 `DEFAULT_LIMIT = 500`，基于 `readdirSync` 读取单层目录，对无法 `stat` 的条目静默跳过。支持 `limit` 和字节截断，溢出时附带通知文本和 `entryLimitReached` 标志。
- **Hermes Agent** 无专用列表工具，通过 `search_files` 的 `target="files"` 模式实现。底层调用 `find` 或 `rg --files`，默认 `limit=50`，始终递归且无深度限制。

### 7.3 readFile 竞品对比

**核心发现：readFile 元数据暴露整体薄弱，仅 Hermes Agent 返回 `file_size`，无任何项目返回 `mtime`。**

| 维度 | Claude Code | OpenCode | OpenClaw | Hermes Agent |
|------|------------|---------|---------|-------------|
| `totalLines` | ✅ `numLines/totalLines` | ✅ TUI 层 `totalLines` | ✅ 截断信息含 `totalLines` | ✅ `total_lines` |
| `fileSize` | ❌（内部 `totalBytes` 未暴露） | ❌ | ❌ | ✅ **`file_size`** |
| `mtime` | ❌（内部 `mtimeMs` 仅用于去重） | ❌ | ❌ | ❌（内部用于去重） |
| MIME 类型 | ✅ | ✅ `mime` 字段 | ✅ | ✅ `mime_type` |
| 图片支持 | ✅ base64 + 尺寸 | ✅ base64 | ✅ base64 | ✅ base64 + 尺寸 |

**分析结论：**

- **Hermes Agent**（`tools/file_operations.py:155-172`）的 `ReadResult` 数据类包含 `file_size` 字段，但输出时需要 `to_dict()` 过滤掉 `None` 值，实际是否暴露取决于调用链。这是唯一一个 readFile 输出中有 size 的竞品，但表述不够稳定。
- **Claude Code** 的 `FileReadTool`（`src/tools/FileReadTool/FileReadTool.ts:258-332`）内部 `readFileInRange()` 已经返回 `totalBytes` 和 `mtimeMs`，但输出 schema 只选了 `numLines/totalLines`，元数据被有意过滤掉了。设计意图可能是避免让大模型分心于非内容信息。
- **OpenClaw** 的 `ReadToolDetails` 包含截断相关的 `totalLines/totalBytes/outputLines`，但这些都是截断计算后的统计量，不是文件自身的系统元数据。

综合来看，readFile 暴露 `sizeBytes` 和 `mtimeMs` 在竞品中几乎没有先例。我们的方案若实现这一增强，需注意不破坏输出的简洁性——可以考虑在正文外附加元数据字段，而非混入正文。

### 7.4 诊断护栏 / 证据体系对比

**核心发现：本项目的四级证据等级体系是独一无二的，四家竞品均无类似机制。**

| 维度 | 本项目 (MyAgent) | Claude Code | OpenCode | OpenClaw | Hermes Agent |
|------|-----------------|------------|---------|---------|-------------|
| 证据等级体系 | ✅ 4级: presence/enumeration/measured/error | ❌ 无 | ❌ 无 | ❌ 无 | ❌ 无 |
| listFiles 调用预算 | ✅ 4次/轮 | ✅ 工具级 `limits.ts` | ❌ | ❌ | ❌ |
| 低价值扫描检测 | ✅ 连续2次阻断 | ❌ | ❌ | ❌ | ❌ |
| 重复读取防护 | ❌ | ✅ mtime 去重 | ❌ | ❌ | ✅ 3次警告4次阻断 |
| `measured` 证据来源 | ✅ 仅 `execute_command` | ❌ | ❌ | ❌ | ❌ |
| 工具循环检测 | ❌ | ❌ | ❌ | ✅ `tool-loop-detection.ts` | ✅ `tool_guardrails.py` |

**分析结论：**

本项目的证据等级体系是独特优势，但当前设计导致结构性偏斜：`listFiles` 最多走到 `enumeration`，`measured` 几乎只从 `execute_command` 产生。这与竞品一致——没有任何项目尝试将结构化工具输出关联到可积累的证据链上。这反过来验证了探索方向：应当将结构化只读工具的输出也纳入 `measured` 证据的识别范围，打破 `execute_command` 对测量级证据的垄断。

竞品中值得借鉴的机制：

- **Hermes Agent** 的重复读取防护（`agent/tool_guardrails.py`）：对相同 `(path, offset, limit)` 在3次时警告、4次时硬阻止，重置机制在上下文压缩后触发。可直接借鉴到本项目的诊断护栏中。
- **OpenClaw** 的工具循环检测（`src/agents/tool-loop-detection.ts`）：检测工具调用循环模式，防止模型陷入无意义的工具调用循环。
- **Claude Code** 的 `limits.ts`：将截断上限集中配置（maxSizeBytes=256KB, maxTokens=25000），而非分散在各工具实现中。

### 7.5 Plan 模式安全体系对比

**核心发现：本项目的 Plan 模式三闸检查是四个项目中最完整的。**

| 维度 | 本项目 (MyAgent) | Claude Code | OpenCode | OpenClaw | Hermes Agent |
|------|-----------------|------------|---------|---------|-------------|
| Plan 模式 | ✅ 完整实现 | ✅ `readOnlyValidation` | ✅ 实验性，仅提示 | ❌ 无 | ❌ 无 |
| 代码级强制执行 | ✅ `isPlanSafeCommand()` 三闸检查 | ✅ flag 级白名单 | ❌ 纯提示依赖 | N/A | N/A |
| Shell 白名单 | ✅ PowerShell/POSIX/CMD 三套 | ✅ bash 为主 | ❌ | N/A | N/A |
| 复合命令阻断 | ✅ 状态机检测 `;&|<>` | ✅ per-flag 粒度 | ❌ | N/A | N/A |
| 子代理计划模式绕过 | ❌ 未验证 | ❌ 未验证 | ✅ 有专项测试 | N/A | N/A |

**分析结论：**

- **OpenCode** 的 Plan 模式（`packages/opencode/src/session/prompt/plan.txt`）是完全基于提示的软约束——写工具（Edit、Write、Patch、Bash）在 Plan 模式下仍然可用，仅靠系统提示要求 LLM 自觉不执行。有专项测试验证子代理是否绕过 Plan 模式限制（`packages/opencode/test/agent/plan-mode-subagent-bypass.test.ts`）。
- **Claude Code** 的 `readOnlyValidation.ts` 采用 per-command flag 级别安全性：对 bash 定义 `safeFlags` 映射，对 PowerShell 定义 cmdlet 级安全标志和风险分类。比我们的 shell 白名单粒度更细，但覆盖范围更窄（以 bash 为主）。
- 本项目的状态机验证（`src/adapters/tools/impl/system/terminal-guard.ts:29`）对 `;&|<>` 等复合操作符的检测是最严格的，且针对 PowerShell/POSIX/CMD 三套 shell 分别维护白名单。

这进一步支持了探索文档的 3.3 节结论：**不应当放宽 Plan 模式的复合命令限制，而是增强通用只读工具**。

### 7.6 Glob/Search 替代工具对比

**核心发现：Glob 和 Search 工具在竞品中普遍基于 ripgrep 实现，本项目的自定义递归方案功能相当，但细节参数可参考优化。**

| 维度 | 本项目 (MyAgent) | Claude Code | OpenCode | OpenClaw | Hermes Agent |
|------|-----------------|------------|---------|---------|-------------|
| Glob 实现 | 自定义 `scanDirAsync` + opendir | ripgrep | ripgrep | fd 命令 | ripgrep |
| Grep 实现 | 自定义递归 + Semaphore 并发 | ripgrep 全参数 | ripgrep 全参数 | grep 工具 | 集成在 search_files |
| 默认 limit | 100 | 100 (glob) / 250 (grep) | 2000 | 1000 (find) | 50 |
| `isTruncated` | ✅ | ✅ | ✅ | ✅ | ✅ |
| 截断通知 | ✅ `notice` 字段 | ✅ | ✅ | ✅ | ✅ `hint` 字段 |
| 按 mtime 排序 | ❌ | ✅ (`--sort=modified`) | ❌ | ❌ | ✅ (内部排序) |
| 并发控制 | ✅ Semaphore(30) | ❌ ripgrep 自身 | ❌ | ❌ | ❌ |

**分析结论：**

- **Claude Code** 的 GlobTool 和 GrepTool 功能最接近统一标准，基于 ripgrep 实现，具有 `truncated` 标志、结果按 mtime 排序、VCS 目录自动排除、`--no-ignore` 和 `--hidden` 环境变量覆盖等特性。我们的自定义递归方案功能等效，但可借鉴其排序和配置灵活性。
- **OpenCode** 的 Glob（`packages/core/src/tool/glob.ts`）和 Grep（`packages/core/src/tool/grep.ts`）同样基于 ripgrep，输入模式统一为 `FileSystem.Entry[]` 简化组合，值得参考的模式设计。
- 本项目当前 Glob 和 Search 工具已经具备 `isTruncated`、`notice`、Semaphore 并发等竞品同类特性，功能面上不落后。主要差距在于：**Glob 和 Search 的输出仍然缺少 size/mtime 元数据**，与 listFiles/readFile 同一问题。

### 7.7 综合结论

#### 7.7.1 元数据缺失是行业通病，但增强方式应保持克制

四个竞品在 listFiles 中没有一个返回 size 或 mtime 元数据。readFile 方面仅 Hermes Agent 暴露 `file_size`，无项目暴露 `mtime`。这意味着探索文档推荐的方向——增强 listFiles/readFile 的元数据能力——是合理的，但更稳妥的落地方式应是“按需暴露”而不是“默认堆满”。

#### 7.7.2 证据等级体系是独特优势，但需要调整 `measured` 的绑定

本项目的四级证据体系（presence/enumeration/measured/error）在竞品中无相似物。但当前 `measured` 几乎绑定到 `execute_command`，需要将结构化只读工具中真正的数量型输出也纳入 `measured` 证据的识别范围，而不是把所有元数据都视为测量证据。

#### 7.7.3 Plan 模式安全能力领先

本项目在 Plan 模式上的三闸检查（shell 白名单 + 高危命令 + 状态机结构验证）是四项目中最完整的。OpenCode 仅靠提示约束不可靠，Claude Code 有 flag 级安全但覆盖范围窄。

#### 7.7.4 竞品的可借鉴点

| 竞品 | 值得借鉴 | 可忽略 |
|------|---------|--------|
| **Claude Code** | FileReadTool 分页设计、结果按 mtime 排序 | 单一 Glob 替代 listFiles 的做法 |
| **OpenCode** | Schema 验证模式、工具组合架构 | 纯提示的 Plan 模式 |
| **OpenClaw** | 自适应分页、工具循环检测 | 无 Plan 模式的设计 |
| **Hermes Agent** | 重复读取防护（3次警告、4次阻断）、`file_size` 暴露 | 统一 search_files 替代列表的做法 |
