## 改造原因

MyAgent 项目长期记忆当前采用「`MEMORY.md` 索引 + `topics/` 子目录主题正文」的两层布局，而 Claude Code 的默认/常见形态为平铺：`memoryDir/` 根下直接存放 `MEMORY.md` 与 `<slug>.md`（官方 `memoryScan.ts` 以递归扫描根下 `.md` 并排除 `MEMORY.md`；提示词示例与用户自己的 Claude Code 记忆目录均即平铺实证，实现允许嵌套但无引导，属兼容残留）。两层布局增加了目录心智与索引/正文间的中间层，与官方默认形态不一致，也不利于后续子代理记忆（官方 `agent-memory/<type>/` 内部同样平铺）复用同一文件契约。本次变更将主记忆布局对齐官方默认平铺形态，同时保留 MyAgent 更严格的单层文件契约。

## 变更内容

- **主题正文位置**：从 `memoryDir/topics/<slug>.md` 改为 `memoryDir/<slug>.md`，主题文件与 `MEMORY.md` 索引同层平铺。
- **索引条目格式**：`- [标题](topics/<slug>.md) — 描述` 改为 `- [标题](<slug>.md) — 描述`（去掉 `topics/` 前缀）。旧格式条目（含路径分隔符）不再被加载器接受——**BREAKING**：既有 `topics/...` 索引在平铺后失效，因当前无存量数据而无迁移成本。
- **保留文件名 `memory.md`**：Windows 等大小写不敏感文件系统上与索引 `MEMORY.md` 指向同一文件，模型将其作为主题名会覆盖索引。加载器将其识别为非法主题名（fail-closed），权限层对大小写不敏感等于 `memory.md` 且原形非 `MEMORY.md` 的写/建目标返回 `deny`（确定性保护，不依赖模型遵守提示词），提示词显式声明禁令。
- **加载器解析契约**：索引正则捕获、topic 路径解析、越界检查根（`memoryDir/topics` → `memoryDir`）全部平铺化。
- **提示词与投影措辞**：`LONG_TERM_MEMORY_RULES`（4 处）与记忆投影前导/空索引提示（2 处）中的 `topics/` 引用改为平铺文件名；`application-paths.ts` 布局注释同步更新。
- **测试与权限样本**：契约测试、loader 单测、权限与工具测试及权限 fixture 中的 topics 路径构造全部迁移为平铺。

**保留不变**：`memoryDir` 位置（`<projectDataDir>/memory/`）、快照语义（有界读取/截断/不可变冻结/刷新边界）、四种记忆类型与容量上限、`.candidates/` 候选暂存隐藏目录、后台记忆 Agent 受限工具策略、自定义根权限边界、忘记操作的先事实源后索引顺序。

**非目标**：不引入官方 recursive 扫描（MyAgent 维持单层 kebab-case 文件名契约）、不提供存量迁移工具（当前无 topics 存量数据）、不涉及子代理记忆（独立 change）。

## 业务能力

### 新增业务能力

（无）

### 修改业务能力

- `markdown-first-long-term-memory`: 主题正文布局从 `topics/` 子目录改为 `memoryDir` 根平铺，索引条目格式与加载器解析契约同步变化。

## 影响范围

- `src/core/usecases/brain/memory-loader.ts`：索引正则、topic 路径解析、越界检查根、保留名校验与注释。
- `src/core/usecases/brain/prompts.ts`：`LONG_TERM_MEMORY_RULES` 措辞与保留名禁令。
- `src/core/usecases/engine/model-request-assembler.ts`：记忆投影前导与空索引提示措辞。
- `src/config/application-paths.ts`：`memoryDir` 注释。
- `src/adapters/tools/permissions/memory-path-policy.ts`：导出保留名共享判定 `isReservedMemoryWriteTarget`（限记忆根内），`checkMemoryPermission` 接入。
- `src/adapters/tools/impl/filesystem/file-system.ts`、`directory-manager.ts`、`apply-patch.ts`：四个写类工具（WriteFileTool/EditFileTool/CreateDirectoryTool/ApplyPatchTool）的 `checkPermissions` 前置保留名拦截。
- 测试：`contract/long-term-memory.test.ts`、`core/usecases/brain/memory-loader.test.ts`、`auto-memory-agent.test.ts`、`memory-permissions.test.ts`、`core/usecases/engine/model-request-assembler.test.ts`、`SessionManager.test.ts`、`adapters/input/interface/commands/memory.test.ts`、`adapters/tools/tools.test.ts`、`test/fixtures/permissions/claude/index.json`。
- **BREAKING**：记忆存储格式变化（旧 `topics/` 索引失效、`memory.md` 保留名生效）。无 API、无外部依赖变更；当前无存量数据，无迁移工具需求（若有存量，`mv topics/*.md .` 并更新索引即可）。
