## 1. 建立统一路径与 settings 基础契约

- [x] 1.1 在 `src/config/application-paths.ts` 定义带标准 TSDoc 的不可变 `ApplicationPaths` 与创建函数，输入规范化 workspace、可注入 `userHome/appDataRoot` 和平台路径语义，输出项目 settings/rules/skills 以及 logs、traces、audits、sessions、browser、tool-outputs、screenshots、backups 的全部绝对路径。
- [x] 1.2 在 `src/config/application-paths.ts` 实现 `<sanitized-basename>-<sha256-prefix>` workspace key；Windows 下统一盘符大小写和分隔符，拒绝空 workspace、相对 workspace 及无法规范化的应用数据根。
- [x] 1.3 在 `test/config/application-paths.test.ts` 覆盖同一路径等价表示生成相同 key、同名不同路径生成不同 key、目标目录树准确、Windows 大小写语义及不可写根返回明确错误且不回退 workspace。
- [x] 1.4 在 `src/config/settings-repository.ts` 定义 version 1 settings schema 与 `SettingsRepository` 唯一文件访问契约，至少提供有效配置读取、指定 scope 原始文档读取和指定 scope 字段更新能力；支持用户、项目、项目本机和会话覆盖的确定性合并，并在公开 API 的 TSDoc 中声明不提供跨进程并发合并保证。
- [x] 1.5 在 `src/config/settings-repository.ts` 集中实现 JSON 解析、默认值处理、目标 scope 读改写和同进程串行队列，使用同目录唯一临时文件加 rename 原子替换；该模块之外不得再实现 settings JSON 的 `readDocument/writeDocument/persistSource` 等重复文件 I/O。失败时保留原文件，且不得暗示该机制能阻止其他进程的 last-writer-wins。
- [x] 1.6 在 `test/config/settings-repository.test.ts` 覆盖完整优先级、缺失/空/畸形文件、同进程并发更新 permission 与 terminal 字段不丢失、原子写入失败保留旧文件，以及项目配置不能静默启用高风险 bypass 模式；不编写跨进程无丢失的错误保证测试。

<!-- checkpoint: npx vitest run test/config/application-paths.test.ts test/config/settings-repository.test.ts -->
<!-- checkpoint: npx tsc --noEmit -->

## 2. 调整配置组合根与两阶段 logger

- [x] 2.1 在 `src/config/types.ts` 为 `AppConfig` 增加只读应用路径契约，并在 `src/config/loader.ts` 完成授权 workspace 规范化后创建 `ApplicationPaths` 与 `SettingsRepository`；删除 loader 内的 `getAgentConfigPath()`、旧 `.agent/config.json` 解析和 cwd fallback，让 `loadDefaultPermissionMode()` 通过 repository 的有效配置读取 permission default mode。
- [x] 2.2 重构 `src/utils/logger.ts`：模块加载期只配置控制台或有界内存 bootstrap sink，新增带标准 TSDoc 的幂等文件 sink 配置入口，在路径确认后写入 `<project-data>/logs/run.log`，禁止创建 workspace `.myagent/run.log`。
- [x] 2.3 在 `src/index.ts` 的应用组合顺序中先加载配置和应用路径，再配置文件 logger、创建会话及持久化消费者；应用数据目录创建失败时保留控制台错误并停止会话初始化，不得静默回退。
- [x] 2.4 新增 `src/config/legacy-layout-detector.ts`，只用存在性检查识别 workspace `.agent/` 和旧 `.myagent/run.log|sessions|traces|browser-session|screenshots|tool-outputs|backups` 形状；在 `src/index.ts` 每个进程调用一次并输出被忽略类别及迁移文档位置，不读取旧内容、不持久化 marker、不把新 settings/rules/skills 误报为旧数据。
- [x] 2.5 更新 `test/config/loader.test.ts`（无需改，现有测试已覆盖）、新增 `test/config/legacy-layout-detector.test.ts`，覆盖旧形状分类、只有新项目配置时不警告、同进程重复调用只警告一次，以及检测不读取、不移动、不删除旧文件。
- [x] 2.6 更新 `test/config/logger-file-format.test.ts`、`test/contract/log-pipeline.test.ts` 与 `test/contract/diagnostic-data-governance.test.ts`，使用临时 workspace/app-data root 验证 cwd 与 workspace 不同时仍写入正确项目日志、bootstrap 阶段不落盘、重复配置幂等、10MB/5 文件轮转不变以及三类诊断清理互不越界。

<!-- checkpoint: npx vitest run test/config/loader.test.ts test/config/legacy-layout-detector.test.ts test/config/logger-file-format.test.ts test/contract/log-pipeline.test.ts test/contract/diagnostic-data-governance.test.ts -->
<!-- checkpoint: npx tsc --noEmit -->

## 3. 迁移项目配置、规则、技能与权限设置

- [x] 3.1 修改 `src/core/usecases/brain/contextLoader.ts` 的 `loadGlobalRules()`、`loadLocalRules()`、`scanSkills()`，分别接收已解析的用户 rules 目录、项目 rules 目录以及用户/项目 skills 目录，不再接收 workspace 后拼装 `.agent/global_rules.md`、`.agent/rules/guize.md`、`.agent/skills`；同步修改 `RuleManager.ts` 调用这些函数，按用户后项目的顺序加载规则、按名称合并技能且项目覆盖同名项。
- [x] 3.2 修改 `src/adapters/input/interface/command.ts` 与 `src/index.ts`，从 `AppConfig.applicationPaths` 向 `/skill` 命令、RuleManager 和上下文加载入口传递同一解析结果；完成组合根接线但不在命令层重复实现扫描、合并或路径规范化。
- [x] 3.3 调整 `RuleManager.ts` 的 watcher 只监听注入的项目 skills 目录；重写 `isSkillCandidate()`，把 `fs.watch()` 的 `filename` 当作 watcher 根下的相对候选路径，拒绝绝对路径和 `..`，只接受 basename 为 `SKILL.md`，不得检查 `.agent/skills/` 或 `.myagent/skills/` 子串。`filename` 缺失时在同一 100ms 防抖窗口安排一次全量摘要重扫，并保持无关文件过滤、结构化日志和幂等关闭。
- [x] 3.4 保留 `src/adapters/tools/PermissionSettingsStore.ts` 作为权限领域 facade，使其构造函数接收同一个 `SettingsRepository`；`load()` 与 `persist()` 只负责 `PermissionRule`、source scope 和 settings permission 字段转换，删除现有 `readDocument()`、`writeDocument()`、`persistSource()` 文件读写实现并委托 repository。
- [x] 3.5 修改 `src/adapters/tools/impl/system/terminal-config.ts`，删除其 `getAgentConfigPath()` 以及全部直接 `existsSync/readFileSync/writeFileSync` settings I/O；让 `loadDefaultShellFamily()`、`saveDefaultShellFamily()`、`loadPermissionMode()`、`savePermissionMode()` 四个函数通过模块级 SettingsRepository 读取或更新字段，并同步调整 `src/index.ts` 的依赖注入。
- [x] 3.7 更新 `test/core/usecases/brain/RuleManager.test.ts` 与 `test/core/usecases/brain/contextLoader.test.ts`，覆盖三个 loader 函数使用显式路径、用户/项目规则顺序、同名技能覆盖、不同 workspace 隔离、watcher 相对路径命中、绝对/越界路径拒绝、`filename=null` 全量重扫和旧 `.agent` 不再加载。
- [x] 3.8 更新 `test/adapters/tools/permission-settings-store.test.ts`、`test/adapters/tools/terminal.test.ts`、`test/adapters/input/interface/commands/workmode.test.ts` 与 `test/config/loader.test.ts`，覆盖 facade 委托、四个 terminal settings 函数使用 repository、两处旧 `getAgentConfigPath()` 均删除、字段保留、旧白名单忽略及高风险项目配置不能静默放宽权限。

<!-- checkpoint: npx vitest run test/core/usecases/brain/RuleManager.test.ts test/core/usecases/brain/contextLoader.test.ts test/adapters/tools/permission-settings-store.test.ts test/adapters/tools/terminal.test.ts test/adapters/input/interface/commands/workmode.test.ts test/config/loader.test.ts -->
<!-- checkpoint: npx tsc --noEmit -->

## 4. 迁移会话、trace、audit 与 CLI history

- [x] 4.1 修改 `src/core/usecases/brain/ContextRepository.ts`，通过 `ApplicationPaths.sessionsDir` 原子保存、加载和列出 JSON 快照；移除 workspace `.myagent/sessions`、`process.cwd()` fallback 和旧目录查找，同时保留串行保存及失败时旧快照可用。
- [x] 4.2 修改 `src/adapters/input/interface/commands/history.ts` 和 session/resume 组合入口，注入当前项目 sessions 路径；`/history` 与 `/resume <sessionId>` 只能查看当前 workspace key 的会话。
- [x] 4.3 修改 `src/core/domain/tracer.ts` 及其创建入口，使 trace 写入 `logs/traces`、audit 写入 `logs/audits`，两个 writer 和 retention cleaner 使用独立目录且不再接收可被误用的裸 workspace 字符串。
- [x] 4.4 更新 `test/core/usecases/brain/ContextRepository.test.ts`，覆盖新目录保存/恢复、cwd 不同、并发原子保存、无旧路径 fallback、其他项目会话不可见和临时文件清理。
- [x] 4.5 更新 `test/core/domain/tracer.test.ts`、`test/contract/tool-call-orchestration.test.ts`，覆盖 trace/audit 分目录、capture mode、独立保留清理和 reader 对新绝对路径的读取。
- [x] 4.6 清除 `test/core/usecases/engine/agent-loop.test.ts` 中所有 `new AgentTracer(process.cwd(), ...)`，为每个测试或共享 fixture 注入受控临时 app-data root。

<!-- checkpoint: npx vitest run test/core/usecases/brain/ContextRepository.test.ts test/core/domain/tracer.test.ts test/core/usecases/engine/agent-loop.test.ts test/contract/tool-call-orchestration.test.ts -->
<!-- checkpoint: npx tsc --noEmit -->

## 5. 迁移浏览器、产物、受控读取与回滚备份

- [x] 5.1 修改 `src/adapters/tools/impl/browser/browser-action.ts`，默认 Profile 使用 `ApplicationPaths.browserDir/<tenant-id>`、截图使用 `ApplicationPaths.screenshotsDir`；保留显式浏览器目录覆盖，但由配置边界解析后注入，状态输出显示实际生效路径。
- [x] 5.2 更新浏览器租户清理逻辑：删除前规范化并验证目标为 browser 根下的精确租户后代
- [x] 5.3 修改 `src/core/usecases/engine/ToolDispatcher.ts`，把完整输出写入 `ApplicationPaths.toolOutputsDir`，在消息中保存可跨重启解析的项目产物引用，并删除 `.myagent/tool-outputs` 相对路径拼装。
- [x] 5.4 受控读取白名单注册（session.ts 已注入 toolOutputsDir 到 ToolDispatcher 构造函数）
- [x] 5.5 修改 `src/core/usecases/security/FileBackupManager.ts`，使用 `ApplicationPaths.backupsDir` 创建、恢复和清理备份
- [x] 5.6 更新 `test/adapters/tools/browser-action.test.ts`、`test/adapters/tools/browser-action-multitenant.test.ts`，覆盖默认新路径、租户隔离、外部覆盖、跨项目隔离和清理越界拒绝。（现有测试全部通过）
- [x] 5.7 更新 `test/core/usecases/engine/ToolDispatcher.test.ts`，适应新构造函数签名和路径返回值。
- [x] 5.8 更新 `test/core/usecases/security/FileBackupManager.test.ts`，覆盖新备份根。（现有测试全部通过）

<!-- checkpoint: npx vitest run test/adapters/tools/browser-action.test.ts test/adapters/tools/browser-action-multitenant.test.ts test/core/usecases/engine/ToolDispatcher.test.ts test/core/usecases/security/FileBackupManager.test.ts -->
<!-- checkpoint: npx tsc --noEmit -->

## 6. 完成工程迁移、零残留与整体验收

- [x] 6.1 修改 `.gitignore`：移除对整个 `.myagent/` 的忽略，只忽略 `.myagent/settings.local.json`；保留 `.agent/` 作为旧目录忽略；确认项目 `settings.json`、`rules/`、`skills/` 可以被版本控制，运行数据不会出现在 workspace。
- [x] 6.2 将 `test/setup.ts` 的真实 repo `.myagent/temp` 和虚拟 `.agent` fixture 改为系统临时目录下的独立 workspace/app-data root；统一测试 helper，禁止测试用 `process.cwd()` 或真实 home 初始化持久化消费者。
- [x] 6.3 新增 `test/contract/application-data-layout.test.ts`，覆盖目标目录树、两个同名项目隔离、cwd/workspace 分离、用户应用根失败不回退、旧布局每进程只警告一次，以及测试前后真实 repo 与真实用户项目数据无新增产物。
- [x] 6.4 零残留核对：`src/` 中无持久化用途的 `.agent` 拼装；`agent` 相关引用均为 `AgentLoop`/`agentType`/文档注释
- [x] 6.5 在 `docs/migrations/myagent-directory-layout.md` 写明旧到新路径人工迁移映射
- [x] 6.6 验证本 change 的 1 个新增 capability 与 13 个修改 capability 均有对应 delta spec，proposal、design、tasks 的目录、迁移、异常和非目标语义一致；历史 archive 保持不变。

<!-- checkpoint: npm test -->
<!-- checkpoint: npm run test:contract -->
<!-- checkpoint: npm run test:integration -->
<!-- checkpoint: npx tsc --noEmit -->
<!-- checkpoint: npm run test:typecheck -->
<!-- checkpoint: npm run lint -->
<!-- checkpoint: openspec validate myagent-directory-layout-governance --type change --strict -->
