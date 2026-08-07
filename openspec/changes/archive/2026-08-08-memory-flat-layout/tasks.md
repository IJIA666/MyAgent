# memory-flat-layout 施工任务单

## 1. 加载器核心解析平铺化与保留名防护

- [x] 1.1 修改 `src/core/usecases/brain/memory-loader.ts`：`INDEX_ENTRY_RE` 去掉 `topics/` 前缀捕获，改为 `^- \[([^\]]+)\]\(([^)]+\.md)\)\s*—\s*(.+)$`；更新正则注释。旧格式条目 `topics/foo.md` 因含 `/` 不匹配 kebab-case，自动失效（fail-closed）。
- [x] 1.2 修改 `diagnoseMemoryTopics`：topic 路径解析由 `resolve(memoryDir, 'topics', filename)` 改为 `resolve(memoryDir, filename)`，越界检查根由 `resolve(memoryDir, 'topics')` 改为 `resolve(memoryDir)`；同步更新 141/295/296 行附近注释。
- [x] 1.3 在 `memory-loader.ts` 增加保留名校验：slug 大小写折叠后等于 `memory` 的文件名（`memory.md` 及任意大小写变体）在启动索引与显式诊断中均记为 `invalidFilenames`，不进入主题列表（fail-closed）。
- [x] 1.4 修改 `src/adapters/tools/permissions/memory-path-policy.ts`：`checkMemoryPermission` 对写/建目标中 basename 大小写折叠等于 `memory.md` 且原形字符串不等于 `MEMORY.md` 的目标返回 `deny`（确定性保护）；原形 `MEMORY.md` 的索引更新写入保持 `allow`。
- [x] 1.5 修改 `createEmptyMemorySnapshot` 相关注释与文件头注释，去除 `topics/` 表述（经查无独立残留，已随 1.1/1.2 清理）。

<!-- checkpoint: npm run build -->

## 2. 提示词与投影措辞平铺化

- [x] 2.1 修改 `src/core/usecases/brain/prompts.ts` 的 `LONG_TERM_MEMORY_RULES`：目录说明（16 行）、frontmatter 写入位置（42 行 `topics/<slug>.md`）、索引示例（59 行 `(topics/<slug>.md)`）、创建前列举与忘记删除路径（66/75 行）共 5 处改为平铺 `<slug>.md` 表述；并新增 `memory.md`（大小写不敏感）保留名禁令声明。
- [x] 2.2 修改 `src/core/usecases/engine/model-request-assembler.ts`：投影前导（404 行「不要把 topics/ 相对路径解析到工作区」）与空索引提示（425 行「创建 MEMORY.md 和 topics/*.md」）改为平铺表述。
- [x] 2.3 修改 `src/config/application-paths.ts`：96 行 `memoryDir` 注释「以 MEMORY.md 为索引、topics/*.md 为主题正文」改为「以 MEMORY.md 为索引、同层平铺 *.md 为主题正文」。

<!-- checkpoint: npm run build -->

## 3. 测试与权限样本迁移

- [x] 3.1 迁移 `test/contract/long-term-memory.test.ts`：MEMORY.md 索引字符串去 `topics/` 前缀、主题文件直接写入 `memoryDir` 根（取消 `mkdirSync(join(dir, 'topics'))`），测试描述「MEMORY.md + topics/*.md 布局」改为平铺表述；新增契约断言：旧 `topics/foo.md` 索引条目不被接受、`memory.md` 为保留名（不进入主题列表）。
- [x] 3.2 迁移 `test/core/usecases/brain/memory-loader.test.ts`：索引构造辅助函数与全部 `topics/` 路径引用改平铺。
- [x] 3.3 迁移 `test/core/usecases/brain/auto-memory-agent.test.ts`：`topics/` 目录构造与目标路径改平铺（`.candidates` 用例保留不动）。
- [x] 3.4 迁移 `test/core/usecases/brain/memory-permissions.test.ts`：`topics` 目录构造与路径改平铺，流程改为「在 memory 根下创建目录/写入根下 topic」，不再创建 `topics/` 子目录。
- [x] 3.5 迁移 `test/core/usecases/engine/model-request-assembler.test.ts` 与 `test/core/usecases/engine/SessionManager.test.ts`：索引快照内容字符串去 `topics/` 前缀。
- [x] 3.6 迁移 `test/adapters/tools/tools.test.ts` 与 `test/adapters/input/interface/commands/memory.test.ts`：索引字符串、目录构造与测试描述改平铺（memory.test.ts 的 `topics` 均为领域标识字段，无路径字面量，仅核查确认）。
- [x] 3.7 迁移 `test/fixtures/permissions/claude/index.json`：writeFile 样本目标由 `memory/topics/note.md` 改为 `memory/note.md`；createDirectory 样本目标由 `memory/topics` 改为 `memory` 根目录（目录路径不能迁移为 `.md` 文件路径）。
- [x] 3.8 新增加载器测试：旧格式索引条目 `- [旧](topics/foo.md) — 描述` 不再被接受（不进入主题列表，记为 `invalidFilenames`）；`memory.md`（含 `Memory.md` 等大小写变体）记为 `invalidFilenames`；显式诊断同样识别保留名。
- [x] 3.9 新增权限测试：对 `memoryDir/memory.md`（及大小写变体）的 write/createDirectory 返回 `deny`，对 `memoryDir/MEMORY.md` 原形的写入保持 `allow`。实现时发现工具层（WriteFileTool/EditFileTool/CreateDirectoryTool/ApplyPatchTool）走 `isAutoMemPath` 链路未经过 `checkMemoryPermission`，已把共享判定导出为 `isReservedMemoryWriteTarget` 并在四个写类工具 checkPermissions 前置拦截。评审后修正：判定先以记忆根限定路径范围（`isReservedMemoryWriteTarget(targetPath, memoryRoot)`），根外目标与未启用记忆时不拦截，避免误伤工作区普通 memory.md；补充「工作区 docs/memory.md 不受影响」「自定义根内拒绝」「未启用不生效」测试。
- [x] 3.10 用 Grep 全量复查 `src/` 与 `test/` 下 `topics/` 路径字面量零残留（仅剩 1 处正则注释说明旧格式失效 + 负向测试用例的刻意构造，均属预期保留）。

<!-- checkpoint: npm run test -->

## 4. 契约与门禁全量验证

- [x] 4.1 运行契约测试 `npm run test:contract`，long-term-memory 契约全部绿色（135/135，含新增 2 例）。
- [x] 4.2 运行 `npm run build`、`npm run lint` 与 `npm run test:typecheck`，全门禁通过（单测 1276/1276）。

<!-- checkpoint: npm run test:contract -->
