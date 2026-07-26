## 1. 应用路径与只读记忆加载器

- [x] 1.1 修改 `src/config/application-paths.ts`，在 `ApplicationPaths`、`createApplicationPaths()` 返回值和对应 TSDoc 中增加 `memoryDir`，固定解析为 `<projectDataDir>/memory/`；同步更新 `test/config/application-paths.test.ts` 与 `test/contract/application-data-layout.test.ts`，覆盖目录分类、不同 `workspace-key` 隔离以及路径不落入工作区 `.myagent/`。
- [x] 1.2 新增 `src/core/usecases/brain/memory-loader.ts`，定义不可变 `MemorySnapshot`、结构化 `MemoryDiagnostic` 与 `loadMemorySnapshot(memoryDir)`；加载器只读 `MEMORY.md` 前 200 行或 20KB（先到者为准），不存在时返回空快照，不得在读取路径创建目录或文件。
- [x] 1.3 在 `memory-loader.ts` 中解析 `MEMORY.md` 索引和 `topics/*.md` frontmatter，校验单层 ASCII kebab-case 文件名、`name`/`description`/`type` 字段及四种固定类型；保留有效条目并报告截断、重复索引、断链、非法文件名、未知类型和无效 frontmatter，单项异常不得抛出为会话启动失败。
- [x] 1.4 新增 `test/core/usecases/brain/memory-loader.test.ts`，覆盖空目录与缺失索引、200 行边界、20KB 边界、两种限制同时超限时的先到边界、UTF-8 字节截断、CRLF frontmatter、读取失败状态、磁盘文件不被修改、有效与无效条目混合、重复索引、断链、非法 slug、未知类型和损坏 frontmatter。

<!-- checkpoint: npx vitest run test/config/application-paths.test.ts test/contract/application-data-layout.test.ts test/core/usecases/brain/memory-loader.test.ts -->
<!-- checkpoint: npm run test:typecheck -->

## 2. 会话快照与模型请求投影

- [x] 2.1 修改 `src/core/usecases/engine/session.ts`，由 `SessionManager` 私有持有当前 `MemorySnapshot` 和 `memoryDir`，在 `open()` 阶段调用 `loadMemorySnapshot()` 完成首次加载；加载异常必须记录结构化诊断并退化为空快照，不得把快照写入 `SessionContext` 或 `ContextRepository`。
- [x] 2.2 修改 `src/core/usecases/engine/agent-loop.ts` 与 `src/core/usecases/engine/model-request-assembler.ts`，通过只读快照提供器传递当前快照；在 `contextAdapter.assemble()` 之后、`BeforeModel` 之前生成独立 `role: 'user'` 的非持久化记忆投影，并插入连续 system 消息之后、持久化会话消息之前；投影始终提供实际绝对 `memoryDir`，空快照生成最小目录说明而不是空消息。
- [x] 2.3 在 `model-request-assembler.ts` 中为记忆投影增加固定的非权威边界说明与内容分隔，确保索引文本不被解释为 system 指令；保持 system reminder 的现有尾部注入语义，并让最终 `ContextBudgetCoordinator` 预算计算包含记忆投影。
- [x] 2.4 修改 `src/core/usecases/brain/prompts.ts`，向 `buildSystemPrompt()` 增加稳定的长期记忆机制规则：四种类型、适合与禁止保存的内容、先查重后创建、主题先于索引写入、显式记住与忘记语义、普通写入不刷新自动快照，以及必须使用标准文件工具而非假设专用 memory 工具。
- [x] 2.5 更新 `test/core/usecases/engine/model-request-assembler.test.ts`、`test/core/usecases/brain/prompt.test.ts` 和 `test/core/usecases/engine/SessionManager.test.ts`，验证消息顺序、空快照仍包含实际目录、索引边界转义、非持久化、预算可见、与 system reminder 共存、启动加载失败降级及 system prompt 规则。

<!-- checkpoint: npx vitest run test/core/usecases/engine/model-request-assembler.test.ts test/core/usecases/brain/prompt.test.ts test/core/usecases/engine/SessionManager.test.ts -->
<!-- checkpoint: npm run test:typecheck -->

## 3. 标准文件工具的精确 memoryDir 授权

- [x] 3.1 修改 `src/adapters/tools/impl/base.ts`，把 `initWorkspace(rootDir)` 扩展为显式接收当前项目 `memoryDir` 的初始化契约，并分别缓存工作区与记忆目录的物理根；重复初始化时必须整体替换两者，避免测试或多会话复用旧项目的记忆根。
- [x] 3.2 修改 `secureResolveReadPath()`、`secureResolveWritePath()` 及其内部共享校验，使标准高层文件 API 可访问工作区物理根或当前项目 `memoryDir` 物理根；不存在写入目标必须从最近现有父目录校验，符号链接不得逃逸，且不得授权 `projectDataDir` 的相邻目录或其他项目的记忆目录。
- [x] 3.3 保持 `terminal-guard.ts` 的 `validateCwd()` 仅允许工作区的现有契约；确认新增记忆根不会进入目录 scope 白名单、call capability 或 shell cwd 判定，文件工具通过路径边界后仍执行原有 effect、`PermissionMode` 与审计流程。
- [x] 3.4 修改 `src/index.ts`，使用 `initWorkspace(appConfig.workspace, appConfig.applicationPaths.memoryDir)` 完成组合根注入；保持 `src/adapters/tools/tools.ts` 现有入口兼容，并在需要 memoryDir 的测试夹具中显式提供隔离目录。
- [x] 3.5 更新 `test/adapters/tools/tools.test.ts` 与 `test/adapters/tools/terminal.test.ts`，通过真实标准文件工具和实际 cwd 校验覆盖 memoryDir 内读写、列举与删除，相邻项目数据拒绝、符号链接及不存在子目标逃逸拒绝、terminal cwd 指向 memoryDir 拒绝，以及重新初始化后旧 memoryDir 失效。

<!-- checkpoint: npx vitest run test/adapters/tools/tools.test.ts test/adapters/tools/new-tools.test.ts test/adapters/tools/terminal.test.ts test/contract/permission-contract.test.ts -->
<!-- checkpoint: npm run test:typecheck -->

## 4. 压缩成功后的快照刷新

- [x] 4.1 修改 `src/core/usecases/brain/CompactionService.ts`，增加可选的异步 `onCompactionCommitted` 回调，并只在摘要校验通过、新历史提交且 `ContextRepository` 持久化成功后调用；压缩失败、跳过或持久化失败不得调用。
- [x] 4.2 修改 `src/core/usecases/engine/session.ts`，将重新调用 `loadMemorySnapshot(memoryDir)` 的刷新函数注入 `CompactionService`；刷新成功时原子替换当前快照，刷新失败时记录结构化诊断并保留旧快照，不得把已经成功的压缩改判为失败。
- [x] 4.3 确认 `CompactionService` 的摘要源只来自 `SessionContext` 持久化历史，请求组装阶段的记忆投影不进入摘要输入；压缩后的下一次请求必须从当前快照重新生成投影，而不是复用旧请求消息。
- [x] 4.4 更新 `test/core/usecases/brain/CompactionService.test.ts` 与 `test/core/usecases/engine/SessionManager.test.ts`，覆盖成功提交后调用刷新、刷新回调异常时压缩仍成功、读取失败保留旧快照、合法空索引替换为空快照，以及压缩失败/跳过/持久化失败不刷新。

<!-- checkpoint: npx vitest run test/core/usecases/brain/CompactionService.test.ts test/core/usecases/engine/SessionManager.test.ts test/core/usecases/engine/model-request-assembler.test.ts -->
<!-- checkpoint: npm run test:typecheck -->

## 5. 记忆维护契约与用户文档

- [x] 5.1 新增 `test/contract/long-term-memory.test.ts`，以临时工作区和临时应用数据根验证静态契约：`memoryDir` 隔离、`MEMORY.md` 加 `topics/*.md` 布局、四种类型、固定容量、独立请求投影，并通过真实原生工具注册表确认标准文件工具存在且无专用 memory 工具。
- [x] 5.2 在 `test/contract/long-term-memory.test.ts` 中增加写入顺序和遗忘规则的提示词契约断言：新主题先写事实源再更新索引；忘记单项时保留仍有效主题；忘记整个主题时先删除主题再删除索引；不得声称能擦除既有会话历史。
- [x] 5.3 新增 `docs/long-term-memory.md`，说明机器本地目录、`MEMORY.md`/`topics` 示例、frontmatter 与 slug 规则、四种类型、适合和禁止保存的内容、显式记住/忘记行为、200 行/20KB 上限、会话启动与压缩刷新边界、标准文件工具权限，以及第一版不包含数据库、RAG、专用工具和自动抽取模型。
- [x] 5.4 检查 `package.json` 与生产源码，确认未新增数据库、向量库、Embedding、RAG、分块或专用记忆模型依赖，未注册专用 memory 工具，也未恢复已移除的旧 `MemoryService` 路径。

<!-- checkpoint: npx vitest run test/contract/long-term-memory.test.ts test/contract/application-data-layout.test.ts -->
<!-- checkpoint: npm run test:typecheck -->

## 6. 全量回归与制品一致性

- [x] 6.1 运行核心、适配器、公共模块和配置测试，修复本 change 引入的回归，不得通过放宽原有工作区路径断言来迁就 memoryDir 例外。
- [x] 6.2 运行契约测试，确认应用目录、安全边界、权限与长期记忆契约同时成立。
- [x] 6.3 运行 lint 与生产构建，修复新增公开 API 的 TSDoc、类型和格式问题，并复核 `proposal.md`、`design.md`、四份 delta spec 与最终实现的一致性。

<!-- checkpoint: npm test -->
<!-- checkpoint: npm run test:contract -->
<!-- checkpoint: npm run lint -->
<!-- checkpoint: npm run build -->
