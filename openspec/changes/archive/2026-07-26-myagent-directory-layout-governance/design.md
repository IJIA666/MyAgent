## 背景

当前路径所有权分散在配置加载、logger、权限 settings、规则与技能、会话仓储、浏览器工具、trace、工具输出和文件备份模块中。虽然 `loadConfig()` 已将授权 workspace 解析为规范化绝对路径，后续模块仍会使用 `process.cwd()`、`homedir()` 或调用方传入的 workspace 重新拼装 `.agent`、`.myagent`。因此同一项目的配置和运行数据可能随启动目录改变，测试也可能写入真实项目。

本设计采用已确认的目录边界：workspace `.myagent` 只存放人工维护的项目配置；程序生成的项目运行数据进入 `~/.myagent/projects/<workspace-key>/`。这是一次零兼容迁移，后续制品不得重新引入旧路径 fallback。

## 目标与非目标

**目标:**

- 以 `.myagent` 统一产品命名空间，消除 `.agent`。
- 明确用户配置、项目配置、项目本机覆盖和项目运行数据的物理作用域。
- 由一个可注入、可测试的路径对象向全部持久化消费者提供路径。
- 将日志、持久状态、会话引用产物和临时数据分层，并使 trace 与 audit 物理分离。
- 保持现有权限判定、规则与技能加载、会话恢复、浏览器登录、回滚和诊断行为。
- 让测试只写入独立临时根，不再污染真实 workspace 或用户目录。

**非目标:**

- 不设计长期记忆的内容格式、写入时机、召回策略或工具接口。
- 不实现跨 Git worktree、仓库改名或 workspace 移动后的数据自动关联。
- 不为同一 settings 文件的多进程并发读改写提供锁、CAS 或合并保证；当前版本只保证单进程内串行和单次文件替换原子性。
- 不改变 OpenAI 协议、工具名称、权限判定优先级或浏览器 CDP 行为。
- 不自动删除、整体移动或长期兼容旧 `.agent`、workspace `.myagent` 运行数据。
- 不调整 `.env`、`mcp_config.json`、OpenSpec 或第三方工具目录。

## 架构决策

### 1. 同一命名空间采用配置与应用数据两个作用域

项目配置固定为：

```text
<workspace>/.myagent/
├── settings.json
├── settings.local.json
├── rules/
└── skills/
```

用户级配置及项目运行数据固定为：

```text
~/.myagent/
├── settings.json
├── rules/
├── skills/
└── projects/<workspace-key>/
    ├── logs/
    │   ├── run.log
    │   ├── traces/
    │   └── audits/
    ├── state/
    │   ├── sessions/
    │   └── browser/<tenant-id>/
    ├── artifacts/
    │   ├── tool-outputs/
    │   └── screenshots/
    └── tmp/backups/
```

选择该方案是因为项目配置需要可提交、可审查，而运行数据需要跨进程保留但不应污染仓库。否决“全部放进 workspace `.myagent`”，因为它仍要求复杂的 ignore 规则，也无法消除运行时和测试产物污染。

### 2. 用不可变 `ApplicationPaths` 作为唯一持久化路径来源

在配置层新增路径解析组件，例如 `src/config/application-paths.ts`。它接收：

- `workspace`：`loadConfig()` 已规范化的 workspace；
- `userHome` 或显式 `appDataRoot`：生产环境默认为用户 home，测试必须注入临时根；
- 平台路径规范化策略。

解析结果至少包含项目 settings/rules/skills、用户 settings/rules/skills，以及项目 logs、traces、audits、sessions、browser state、tool outputs、screenshots 和 backups 路径。应用组合根在 `loadConfig()` 后只创建一次该对象，并注入 logger、`PermissionSettingsStore`、`RuleManager`、`ContextRepository`、`AgentTracer`、browser action、`ToolDispatcher`、`FileBackupManager` 和 CLI history。

持久化消费者不得再根据 `.agent`、`.myagent`、`process.cwd()` 或 `homedir()` 自行推导路径。普通文件工具仍可使用当前授权 workspace 作为业务文件根，这不属于应用数据持久化。

选择集中解析而不是提供若干路径辅助函数，是为了让路径集合、项目身份和测试根在构造时完成一致性校验，并避免模块继续混用不同 fallback。

### 3. workspace key 由规范化路径稳定生成

`workspace-key` 使用“清洗后的 workspace basename + `-` + 规范化绝对路径 SHA-256 摘要前 12 位”。Windows 路径在摘要前统一分隔符、盘符大小写和大小写语义，避免同一目录因表示形式不同产生多个 key；同名但路径不同的项目通过摘要隔离。

不使用纯 basename，因为会碰撞；不使用 Git common-dir，因为项目不一定是 Git 仓库，并且本 change 不承诺 worktree 共享。workspace 改名或移动后形成新 key 是第一版明确接受的权衡。

### 4. settings 采用统一 schema、分层读取和原子字段更新

统一 settings 契约：

```json
{
  "version": 1,
  "permission": {
    "defaultMode": "default",
    "allow": [],
    "ask": [],
    "deny": []
  },
  "terminal": {
    "defaultShellFamily": "auto"
  }
}
```

有效配置优先级为：会话或 CLI 临时值 > 项目 `settings.local.json` > 项目 `settings.json` > 用户 `settings.json` > 内建默认值。数组字段由具体 settings 契约决定替换，不进行隐式拼接；缺失字段继承低优先级值。

`SettingsRepository` 是 settings JSON 解析、作用域合并、字段更新和原子文件替换的唯一所有者。它对消费者暴露有效配置读取和指定 scope 字段更新接口，并在单进程内串行执行同一目标文件的读改写；写入时读取目标 scope 的完整对象，只更新调用方负责字段，通过同目录唯一临时文件加 rename 原子替换。

现有 `PermissionSettingsStore` 保留为权限领域的窄 facade，以避免权限服务依赖通用配置 schema；其 `load()`、`persist()` 负责 `PermissionRule` 与 settings permission 字段之间的转换，但删除自身的 `readDocument()`、`writeDocument()`、`persistSource()` 文件读写实现，全部委托给同一个 `SettingsRepository`。`terminal-config.ts` 保留现有四个业务操作的职责，但 `loadDefaultShellFamily()`、`saveDefaultShellFamily()`、`loadPermissionMode()`、`savePermissionMode()` 必须通过显式注入的 repository 读取或更新 terminal/permission 字段。

`loader.ts` 和 `terminal-config.ts` 中重复的 `getAgentConfigPath()` 全部删除，不改造成新的路径 helper。`loadDefaultPermissionMode()` 也改为在 `ApplicationPaths` 创建后通过 repository 读取有效配置。`terminal.ts`、`commands/workmode.ts` 与组合根同步调整依赖传递，任何消费者都不得再次根据 `getAuthorizedDir()`、环境变量或 cwd 推导 settings 路径。

当前版本不引入跨进程文件锁或 CAS。同一项目的多个 MyAgent 进程，或者多个进程同时修改用户 settings 时，最后完成写入的进程可能覆盖另一进程基于旧快照生成的字段更新；JSON 文件本身仍保持完整，但不保证合并全部并发变更。选择明确限制而不是此时引入锁，是因为跨平台锁的过期、崩溃恢复和网络文件系统语义需要独立设计。后续出现真实多进程写入需求时再增加文件锁或基于版本的 CAS。

项目 `settings.json`、rules 和 skills 可提交；`.gitignore` 只忽略 `.myagent/settings.local.json`。仓库来源的项目配置不得无提示启用 `bypassPermissions`，继续服从现有权限安全边界。

### 5. 规则和技能按用户、项目两层组合

用户级规则和技能来自 `~/.myagent/rules`、`~/.myagent/skills`，项目级内容来自 `<workspace>/.myagent/rules`、`<workspace>/.myagent/skills`。同名技能以项目级定义覆盖用户级定义；不同名内容合并。规则按用户级后项目级的稳定顺序注入，使项目规则更接近当前任务。

`contextLoader.ts` 的 `loadGlobalRules()`、`loadLocalRules()` 和 `scanSkills()` 改为接收已解析的用户/项目 rules 或 skills 路径，不再接收 workspace 后自行拼装产品目录。`RuleManager` 的 watcher 只监听已注入的项目 skills 目录；用户级内容在新会话初始化时读取，本 change 不增加跨项目全局 watcher。

`fs.watch()` 回调中的 `filename` 被视为 watcher 根下的相对候选路径：规范化后拒绝绝对路径和 `..` 逃逸，仅以 basename 是否为 `SKILL.md` 判断技能主体，不检查 `.agent/skills/` 或 `.myagent/skills/` 子串。底层平台未提供 filename 时，系统在同一防抖窗口内安排一次项目 skills 全量摘要重扫，不能静默丢弃可能的真实变更。

原 `.agent/global_rules.md`、`.agent/rules/guize.md` 通过人工迁移分别进入用户或项目 `rules/`，运行时不读取旧文件。

### 6. logger 使用两阶段初始化

配置加载完成前，logger 只使用控制台 sink 或有界内存缓冲，不创建文件。`loadConfig()` 确认 workspace 并生成 `ApplicationPaths` 后，组合根将文件 sink 配置为 `<project-data>/logs/run.log`，再刷新必要的启动事件。

应用数据根创建失败时保留控制台错误输出并中止需要持久化路径的会话初始化；不得静默回退到 workspace。logger 配置接口必须幂等，测试可以注入空 sink 或临时路径。

选择两阶段初始化而不是继续使用 import-time `process.cwd()`，是因为文件路径只有在授权 workspace 确认后才具有正确项目归属。

### 7. 运行数据按生命周期分类治理

- `logs/run.log`：保留 10MB、最多 5 个轮转文件。
- `logs/traces` 与 `logs/audits`：分别执行现有天数和文件数量限制，不能共用清理列表。
- `state/sessions`：由会话保留与恢复语义管理，不随 trace 清理。
- `state/browser/<tenant-id>`：保留登录状态，只有显式临时租户清理才删除。
- `artifacts`：其文件可能被会话引用，清理策略必须与引用生命周期一致。
- `tmp/backups`：服务回滚事务，会话正常关闭时幂等清理，并允许清理崩溃遗留。

分类目录的目的不仅是可读性，还用于限制清理器的删除边界。任何清理操作只能在 `ApplicationPaths` 提供的精确子目录内执行。

### 8. 用户应用目录中的工具输出采用受控只读访问

`ToolDispatcher` 将完整输出写入项目 `artifacts/tool-outputs`，并在消息结构中保存可解析的稳定引用。由于该目录位于授权 workspace 外，文件读取授权层只额外允许读取当前 `ApplicationPaths.toolOutputsDir` 的规范化后代路径；不得授权整个 `~/.myagent`，不得允许 `..`、符号链接或大小写绕过逃逸。

这保留了模型通过 `readFile` 分页调阅完整输出的现有能力，同时不扩大到 settings、sessions、browser profile 或其他项目数据。截图引用使用同一项目身份定位，但不自动授予任意工具写入用户目录。

### 9. 测试根必须显式注入

测试创建独立的临时 workspace 与 `appDataRoot`，再构造 `ApplicationPaths`。`AgentTracer(process.cwd(), ...)`、切换 cwd 迫使 logger 落盘以及真实 `.myagent/temp` 测试沙箱都必须迁移。测试结束时只清理本测试创建且已解析验证的临时目录。

增加契约测试，在代表性测试套件执行前后确认真实 repo `.myagent` 与真实用户 `~/.myagent/projects` 没有新增测试产物。

### 10. 旧目录只检测并警告，不隐式迁移

启动配置阶段只检查旧目录形状是否存在，包括 workspace `.agent/`，以及 workspace `.myagent/run.log`、`sessions/`、`traces/`、`browser-session/`、`screenshots/`、`tool-outputs/`、`backups/`。检测不得读取旧配置内容，不得把普通的新项目 `.myagent` 配置目录误判为旧运行数据。

同一进程首次发现任一旧形状时输出一次结构化 WARN 和一条面向用户的迁移提示，列出被忽略的旧类别及 `docs/migrations/myagent-directory-layout.md`。本次启动后重复初始化 logger、session 或工具不得重复刷屏。警告不创建持久 marker，因此下次进程启动仍会提醒，直到用户完成人工迁移或移除旧目录。

## 迁移计划

1. 新增 `ApplicationPaths`、workspace key 和统一 settings repository，并先用单元测试锁定目录树、优先级、原子更新、失败语义和 Windows 路径等价性。
2. 调整启动组合根与 logger 两阶段初始化，让新旧消费者迁移期间都从同一对象取得路径；代码不得增加旧路径 fallback。
3. 迁移规则/技能、权限/终端配置、会话/history、trace/audit、浏览器、工具输出/截图和备份消费者。
4. 迁移工具输出的受控只读资源根和全部相关测试，清除测试对真实 cwd/app-data 的写入。
5. 增加旧目录形状检测和每进程一次的迁移警告，但不读取、移动或删除旧数据。
6. 更新 `.gitignore`、当前 OpenSpec 和用户迁移说明；通过零残留搜索确认除旧布局检测器与迁移文档外，`src/`、`test/` 和当前 specs 不再包含 `.agent` 或 workspace 运行数据旧路径。

人工迁移映射以 `exploration.md` 的表格为准。应用不自动移动或删除旧数据。由于运行时只认新路径，回滚代码版本时旧版本仍读取原路径；若用户手工迁移过配置，需要按映射反向复制，不能依赖双写回滚。

## 风险与权衡

- **启动期日志依赖 workspace** -> 使用控制台/内存 bootstrap logger，配置完成后再启用文件 sink。
- **用户应用目录不可写** -> 输出明确的解析路径和受治理错误并停止持久化会话，不回退到 workspace。
- **工具输出移出沙箱后不可读** -> 只给当前项目 tool-output 目录增加规范化、只读的精确资源授权，并覆盖越界测试。
- **workspace 移动后无法发现旧状态** -> 第一版接受新 key；不在本 change 引入 Git identity 或模糊目录扫描。
- **项目配置可能放宽权限** -> 项目来源配置继续受权限模式安全限制，危险模式不得静默生效。
- **零兼容导致旧数据不可见** -> 提供人工映射并保留旧文件，不自动删除；避免长期双读造成数据分叉。
- **同一 settings 文件被多个进程并发更新时丢失字段变更** -> 当前版本明确不保证跨进程合并；单进程内串行并原子替换，后续以独立 change 设计跨平台文件锁或 CAS。
- **同一项目多个进程共享 run.log 时日志交错或轮转竞争** -> 当前版本接受诊断日志顺序和轮转不具备多进程保证，不把日志成功作为业务事务提交条件。
- **运行数据清理误删会话引用** -> 日志、状态、产物、临时数据使用独立清理边界，产物清理必须感知引用。

## 待确认问题

没有会改变 capability、运行时边界或任务范围的开放问题。长期记忆是否按 workspace key 或未来 repository key 共享，留给后续独立探索。
