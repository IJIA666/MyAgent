# 探索主题: MyAgent 配置与运行数据目录治理

## 1. 问题定义

当前项目同时使用 `<workspace>/.agent/` 与 `<workspace>/.myagent/`。前者存放配置、规则和技能，后者同时存放项目权限设置、运行日志、会话、trace、浏览器 profile、截图、工具输出和回滚备份。两个根目录没有形成稳定的“配置/数据”边界，`.myagent` 内部也缺少日志、持久状态、用户产物和临时数据的清晰分层。

更严重的是，各模块对项目根目录的认知不一致：部分路径基于 `process.cwd()`，部分基于 `appConfig.workspace`，部分允许构造参数覆盖，用户级设置又直接基于 `homedir()`。这会导致同一个会话在不同启动目录、授权工作区或测试场景下把文件写入不同位置。目录优化不能只做字符串替换，必须同时统一目录语义、作用域、路径解析和测试隔离。

本次探索只处理 MyAgent 自有配置与运行数据目录。`.env`、`mcp_config.json`、OpenSpec、源码产物和第三方工具目录不在本次范围内。长期记忆规划依赖本次目录决策，暂不在这里设计记忆内容与召回行为。

## 2. 关键发现与调研结果

- **代码库现状**：
  - 当前 `<workspace>/.agent/` 实际包含：
    - `config.json`：由终端配置模块读写 `permissionMode` 与 `defaultShellFamily`；
    - `skills/`：由 `RuleManager` 与 `contextLoader` 扫描；
    - `rules/guize.md` 与 `global_rules.md`：若存在则作为提示词规则加载；
    - `allowed_commands.json`：当前磁盘文件为空，生产代码已不再读取。
  - 当前 `<workspace>/.myagent/` 根目录直接包含 `run.log` 与 `settings.local.json`，并包含 `sessions/`、`traces/`、`browser-session/`、`screenshots/`、`tool-outputs/`、`backups/` 等运行目录。日志、诊断、持久状态、用户产物和临时数据没有统一分类。
  - 项目权限配置存在重叠：
    - `.agent/config.json` 保存默认权限模式；
    - `.myagent/settings.local.json` 保存 `allow/ask/deny` 权限规则；
    - 当前 `security-modes` 规格仍声称使用 `.agent/allowed_commands.json`，已经与生产实现不一致。
  - 路径根来源分散：
    - `logger.ts`、`history.ts`、浏览器 profile 与截图默认使用 `process.cwd()`；
    - `AgentTracer` 使用传入的 `workspaceDir`；
    - `ContextRepository` 使用 `workspacePath ?? appConfig.workspace ?? process.cwd()`；
    - `ToolDispatcher` 使用 `workspacePath ?? process.cwd()`；
    - `FileBackupManager` 要求显式传入 `workspacePath`；
    - `PermissionSettingsStore` 同时拼装 workspace 与 home 下的 `.myagent`。
  - `loadConfig()` 已通过 `realpathSync(resolve(...))` 生成规范化的 `appConfig.workspace`，但多数持久化消费者没有依赖统一路径对象。
  - 测试会污染真实项目目录。`agent-loop.test.ts` 多处使用 `new AgentTracer(process.cwd(), ...)`，当前 `.myagent/traces/` 中可见 `trace_test-*`、`trace_overflow-*` 等测试文件。这证明路径散落已经造成真实副作用，不是单纯审美问题。
  - 当前 `.gitignore` 同时忽略整个 `.agent/` 和 `.myagent/`。因此 `.agent` 即使存放规则与技能，也没有形成“可提交项目配置”的实际语义。
  - 当前有效 OpenSpec 中至少有以下能力直接固化旧路径：`base-stability`、`browser-multi-tenant`、`brain-state-isolation`、`context-injection-engine`、`context-rollback`、`diagnostic-data-governance`、`logging-observability-and-naming`、`rules-injection-caching`、`security-modes`、`session-persistence`、`tool-output-offloading`、`trace-logging`、`unified-logger` 与 `web-automation`。
- **核实与洞察**：
  - [Claude Code 官方目录说明](https://code.claude.com/docs/en/claude-directory)将项目中由用户维护、可提交的配置放在 `.claude/`，将 transcript、工具输出、文件快照、缓存和 debug 日志放在用户目录 `~/.claude/` 的应用数据区域，并为自动清理定义不同保留策略。
  - [Claude Code 配置作用域说明](https://code.claude.com/docs/en/configuration)采用 `~/.claude/settings.json`、`.claude/settings.json`、`.claude/settings.local.json` 的用户、项目、项目本机三级作用域；本地配置覆盖项目配置，项目配置覆盖用户配置。
  - 参考实现的重点不是照搬 `.claude` 命名，而是让“人维护的项目配置”和“程序写出的运行数据”不共用同一个仓库目录。运行数据中又应区分：
    - 需要保留的状态：会话、浏览器登录 profile；
    - 诊断日志：运行日志、trace、audit；
    - 会被会话引用的产物：完整工具输出、截图；
    - 只服务当前事务的临时数据：回滚备份。
  - 单纯将 `.agent` 合并进 workspace 下的 `.myagent`，仍会让运行数据与项目配置混在一起；单纯保留两个根目录并改名子目录，则无法消除配置所有权和路径解析重复。
  - MyAgent 当前尚无 Git 根或 Git common-dir 身份解析器。目录优化不应顺便承诺跨 worktree 共享全部运行状态。第一版可使用“规范化 workspace 绝对路径的稳定哈希”构造 workspace key；未来记忆若需要跨 worktree 共享，应单独增加 repository key，而不是让会话、浏览器状态和日志被动共享。

## 3. 方案对比与推荐方向

| 评估维度 | 方案 A：保留 `.agent` 与 `.myagent` | 方案 B：全部合并到 workspace `.myagent` | 方案 C：统一命名，项目配置与用户应用数据分离 | 结论 |
| :--- | :--- | :--- | :--- | :--- |
| 根目录数量 | 两个 | 一个项目根 | 一个统一名称、两个明确作用域 | C 语义最清晰 |
| 项目配置可提交 | 可做到，但当前未做到 | 需要复杂 ignore 例外 | workspace `.myagent` 专用于配置，天然可提交 | C 最合理 |
| 运行数据污染仓库 | `.myagent` 持续污染 | 仍然污染 | 运行数据移至 `~/.myagent/projects/` | C 消除污染 |
| 配置所有权 | `config.json` 与 `settings.local.json` 重叠 | 可合并 | 可统一为 user/project/local settings | B/C 均可解决 |
| 日志治理 | 需要在 `.myagent` 内继续整理 | 可增加 `logs/` | 项目应用数据下独立 `logs/`，并按 trace/audit 分开 | C 最完整 |
| 多项目隔离 | 依赖各工作区目录 | 依赖各工作区目录 | 用户应用数据按 workspace key 隔离 | C 更稳定 |
| 测试隔离 | 仍容易写进真实 workspace | 仍容易写进真实 workspace | 路径解析器可注入测试 app-data root | C 更容易验证 |
| 迁移规模 | 中 | 中 | 较大 | C 成本最高但消除根因 |

**推荐路径**：选择方案 C。统一使用 `.myagent` 作为产品命名空间，但明确区分两个物理作用域：

1. `<workspace>/.myagent/`：只放项目配置、规则和技能；
2. `~/.myagent/`：放用户配置以及按 workspace 隔离的应用运行数据。

### 3.1 目标目录树

```text
<workspace>/
└── .myagent/
    ├── settings.json
    ├── settings.local.json
    ├── rules/
    │   └── *.md
    └── skills/
        └── <skill-name>/
            └── SKILL.md

~/.myagent/
├── settings.json
├── rules/
│   └── *.md
├── skills/
│   └── <skill-name>/
│       └── SKILL.md
└── projects/
    └── <workspace-key>/
        ├── logs/
        │   ├── run.log
        │   ├── traces/
        │   │   └── trace_<session-id>.jsonl
        │   └── audits/
        │       └── audit_<session-id>.jsonl
        ├── state/
        │   ├── sessions/
        │   │   └── session_<session-id>.json
        │   └── browser/
        │       └── <tenant-id>/
        ├── artifacts/
        │   ├── tool-outputs/
        │   └── screenshots/
        └── tmp/
            └── backups/
```

目录语义：

- `settings.json`：可共享的项目配置或用户全局配置；
- `settings.local.json`：当前用户在当前项目的本机覆盖，只存在于 workspace；
- `rules/`、`skills/`：项目作用域和用户作用域采用相同结构，项目内容覆盖或补充用户内容；
- `logs/`：只放诊断数据，`run.log`、trace、audit 物理分离；
- `state/`：删除后会丢失功能状态或恢复能力，不能当缓存清理；
- `artifacts/`：可被会话消息或用户引用的生成物，不应按普通 cache 随意删除；
- `tmp/`：仅服务当前事务，可在正常关闭或崩溃恢复后清理。

未来长期记忆若采用用户目录按项目隔离，可在 `<workspace-key>/memory/` 或独立 `<repository-key>/memory/` 下设计；本次不提前创建。

### 3.2 设置文件统一

- 删除 `.agent/config.json` 这一独立存储。
- 将 `permissionMode`、`defaultShellFamily` 和现有 `permissions.allow/ask/deny` 统一到同一 settings 契约：

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

- 设置优先级采用：命令行/会话临时值 > `.myagent/settings.local.json` > `.myagent/settings.json` > `~/.myagent/settings.json` > 内建默认值。
- `PermissionSettingsStore` 与 `terminal-config.ts` 不再各自读写不同文件，应共享同一个配置仓储或同一个原子更新接口。
- `.agent/allowed_commands.json` 属于已退役权限模型，不迁移到新目录；当前 `security-modes` 与 `brain-state-isolation` 规格必须改写为现行 `PermissionMode` 和 `allow/ask/deny` 契约。

### 3.3 统一路径解析边界

新增唯一的应用路径解析组件，例如 `AppPathResolver`，构造输入只包含：

- 规范化的 `workspace`；
- 可注入的 `userHome` 或 `appDataRoot`；
- 可选的平台路径策略。

它负责生成所有路径：

- 项目 settings、rules、skills；
- 用户 settings、rules、skills；
- workspace key；
- logs、traces、audits；
- sessions、browser；
- tool outputs、screenshots；
- temporary backups。

约束：

- `loadConfig()` 确认 `appConfig.workspace` 后创建一次路径对象，并注入所有消费者；
- 业务模块不得再出现 `.agent`、`.myagent`、`process.cwd()` 或 `homedir()` 的持久化路径拼装；
- 显式环境覆盖（如 `BROWSER_USER_DATA_DIR`）仍可保留，但必须由配置边界解析后传入浏览器模块；
- workspace key 使用规范化 workspace 绝对路径的稳定摘要，并带可读 basename，避免同名项目冲突；
- 测试必须注入临时 app-data root，不能使用真实 `process.cwd()` 生成 trace 或其他运行文件。

### 3.4 日志初始化与保留策略

当前 logger 在配置加载前按 `process.cwd()` 创建 `.myagent/run.log`。运行数据迁移到用户应用目录后，启动链路应调整为：

1. 最早期 logger 只启用控制台或内存缓冲；
2. `loadConfig()` 确认 workspace；
3. 创建 `AppPathResolver`；
4. 将文件 sink 配置到 `<project-data>/logs/run.log`；
5. 刷新必要的启动事件。

不能为了继续使用 import-time 单例而把新的日志路径再次绑定到 `process.cwd()`。

保留治理继续区分：

- `run.log`：10MB、最多 5 个轮转文件；
- `logs/traces/`：按 trace 保留窗口清理；
- `logs/audits/`：按 audit 保留窗口独立清理；
- `state/sessions/`：由会话保留策略治理，不能跟随 trace 清理；
- `tmp/backups/`：会话关闭幂等清理，并提供崩溃遗留清理；
- `artifacts/`：必须先定义与会话引用一致的保留策略，不能简单按启动时间全删。

### 3.5 迁移与验收边界

本项目处于早期阶段，推荐零兼容迁移：

- 生产运行时只读取新目录，不增加长期双读、双写或旧路径 fallback；
- 不自动删除用户现有 `.agent/`、workspace `.myagent/` 或 `~/.myagent/` 文件；
- 在变更说明中提供一次性人工迁移映射；
- archive 保持历史原样，当前 specs、生产代码和测试必须全部切换到新契约。

建议映射：

| 旧路径 | 新路径 |
| :--- | :--- |
| `.agent/config.json` | `.myagent/settings.local.json` 中对应字段 |
| `.agent/rules/`、`.agent/global_rules.md` | `.myagent/rules/` 或 `~/.myagent/rules/` |
| `.agent/skills/` | `.myagent/skills/` |
| `.myagent/settings.local.json` | `.myagent/settings.local.json`，按新 schema 合并 |
| `.myagent/run.log` | `~/.myagent/projects/<key>/logs/run.log` |
| `.myagent/traces/trace_*` | `~/.myagent/projects/<key>/logs/traces/` |
| `.myagent/traces/audit_*` | `~/.myagent/projects/<key>/logs/audits/` |
| `.myagent/sessions/` | `~/.myagent/projects/<key>/state/sessions/` |
| `.myagent/browser-session/` | `~/.myagent/projects/<key>/state/browser/` |
| `.myagent/tool-outputs/` | `~/.myagent/projects/<key>/artifacts/tool-outputs/` |
| `.myagent/screenshots/` | `~/.myagent/projects/<key>/artifacts/screenshots/` |
| `.myagent/backups/` | `~/.myagent/projects/<key>/tmp/backups/` |

验收要求：

- `src/`、`test/`、当前 `openspec/specs/` 中无 `.agent` 残留；
- 除项目配置解析器外，生产模块中无 workspace `.myagent` 运行数据路径拼装；
- 所有持久化消费者只使用注入的路径对象；
- trace 与 audit 不再共用目录；
- 项目根目录不再生成 `run.log`、session、trace、browser profile、截图、工具输出或备份；
- 测试执行前后真实 workspace 和真实用户应用目录均无新增产物；
- 项目 `.gitignore` 只忽略 `.myagent/settings.local.json` 等本机配置，不忽略整个 `.myagent/`；
- 当前 OpenSpec 与新路径契约一致，历史 archive 不改写。

## 4. 约束、风险与未知项

- **启动期日志循环依赖**：配置加载本身会产生日志，而文件日志路径依赖已加载的 workspace。需要明确的 bootstrap logger 阶段，不能在路径解析器中反向依赖 logger。
- **用户目录写权限**：`~/.myagent/projects/` 创建失败时应保留控制台能力并给出明确错误，不能静默回退到 workspace 重新制造双路径。
- **workspace key 稳定性**：规范化路径改名后会得到新 key。第一版接受这一行为；如果未来要求跨路径移动或 worktree 共享，需要独立 repository identity 设计。
- **项目配置可信度**：可提交的 `.myagent/settings.json` 来自仓库，不能允许它无提示开启 `bypassPermissions` 或放宽高风险权限。配置迁移必须保留现有权限安全边界。
- **产物保留**：工具输出被历史消息引用，截图可能是用户交付物。迁移目录时必须同步更新消息中保存的相对/绝对引用策略，并先定义保留周期。
- **浏览器外部覆盖**：`BROWSER_USER_DATA_DIR` 仍可把浏览器 profile 放到其他位置，状态命令与清理逻辑必须显示实际解析路径。
- **旧本地数据**：零兼容迁移不代表自动删除。旧目录应保留给用户人工审计和迁移，应用不得悄悄清理。
- **规则作用域**：当前 `global_rules.md` 位于 workspace，却名为 global。迁移时需要把真正用户全局规则放到 `~/.myagent/rules/`，项目规则放到 `.myagent/rules/`，不能只机械改文件名。

## 5. 否决方案

- **只新增 `.myagent/logs/`**：能解决根目录下 `run.log` 的视觉问题，但保留了两个配置根、路径解析分散、trace/audit 混放和测试污染。
- **保留 `.agent` 与 `.myagent`，仅写一份目录说明**：两个目录当前没有 git 跟踪和运行时所有权上的强制边界，文档无法阻止新模块继续任选其一。
- **把所有内容都搬到 workspace `.myagent/`**：虽然只剩一个目录，但日志、会话、浏览器 profile 和工具输出仍污染仓库，并使 `.gitignore` 与可提交配置产生复杂冲突。
- **继续让各模块接收 workspace 字符串后自行拼路径**：目录名改变后仍会重复出现 `process.cwd()`、fallback 和测试落盘问题，无法建立长期稳定边界。
- **在新旧目录之间长期双读或双写**：会制造优先级冲突、数据分叉和无法删除的兼容层；本项目没有历史包袱，不值得承担。
- **自动删除或整体移动现有目录**：日志、会话、浏览器登录状态和用户配置可能仍有价值，自动破坏不符合迁移安全边界。
