## 新增需求

### 需求: ShellKind 枚举定义与分辨率

系统必须（MUST）定义 `ShellKind` 枚举，其取值范围为 `auto | posix | powershell | cmd`，作为平台 shell 语义的受控入口。当取值为 `auto` 时，系统必须按以下优先级决议为具体值：显式传入的 shellKind > 全局配置 `defaultShellFamily` > 平台编译时常量默认值（Windows → `powershell`，POSIX → `posix`）。

#### 场景: Windows 平台默认分辨率
- **WHEN** 模型调用 `execute_command` 时未传入 `shellKind` 参数，且全局配置中未设置 `defaultShellFamily`，当前运行平台为 Windows
- **THEN** 系统内部将 `shellKind` 解析为 `powershell`

#### 场景: POSIX 平台默认分辨率
- **WHEN** 模型调用 `execute_command` 时未传入 `shellKind` 参数，且全局配置中未设置 `defaultShellFamily`，当前运行平台为 Linux/macOS
- **THEN** 系统内部将 `shellKind` 解析为 `posix`

#### 场景: 全局配置覆盖默认值
- **WHEN** 全局配置中 `defaultShellFamily` 已设置为 `posix`，当前平台为 Windows
- **THEN** 系统内部将 `shellKind` 解析为 `posix`，而非 Windows 平台默认的 `powershell`

#### 场景: 模型显式传入 shellKind 优先于所有默认值
- **WHEN** 模型调用 `execute_command` 时显式传入 `shellKind: "cmd"`，无论全局配置和平台默认值为何
- **THEN** 系统内部将 `shellKind` 解析为 `cmd`

### 需求: ShellExecutionPlan 工厂生成

系统必须（MUST）提供 `createShellExecutionPlan` 工厂函数，根据已决议的 `shellKind`、原始命令文本和配置上下文，一次性生成不可变的 `ShellExecutionPlan` 数据对象。该 Plan 必须包含：已决议的 `shellKind`、剥壳后的核心命令文本、执行参数（`executable` + `argv` 数组）以及平台特化执行选项。

#### 场景: PowerShell shellKind 生成执行计划
- **WHEN** `shellKind` 为 `powershell`，命令为 `npm install express`
- **THEN** 工厂生成的 Plan 必须产出一组可执行的 `executable + argv` 组合，并在 Windows 场景下保留 npm/npx 兼容能力，不要求需求文本绑定到某个具体二进制路径或特定 argv 形状

#### 场景: POSIX shellKind 生成执行计划
- **WHEN** `shellKind` 为 `posix`，命令为 `ls -la`
- **THEN** 工厂生成的 Plan 必须使用 POSIX 语义解析命令，且其平台特化选项中不应包含仅针对 PowerShell 的编码引导逻辑

#### 场景: 显式 shellKind 下不再自动剥壳
- **WHEN** 模型显式传入 `shellKind: "posix"`，命令为 `bash -c "git log --oneline"`
- **THEN** 工厂必须优先采用显式声明的 shell family，而不是再次通过命令前缀自动推断 shell 语义；是否保留外层包裹命令，由同一工厂决议并向 Guard/Engine 统一下发

#### 场景: 显式指定不受支持的 shell family 时给出明确失败
- **WHEN** `shellKind` 被显式设为 `powershell`，但当前运行平台为 Linux 且环境中未安装 PowerShell
- **THEN** 系统必须返回清晰的“不支持该 shell family”错误，且不得静默改用 `posix` 或其他 shell 执行原命令

### 需求: 平台特化执行选项的封装

`ShellExecutionPlan` 中的 `PlatformExecutionOptions` 必须（MUST）封装所有平台特化行为，包括但不限于：进程树强杀命令模板、npm/npx CLI 路径重定向配置、终端输出编码引导脚本以及 `shell: false` 执行模式的确认标志。

#### 场景: Windows 平台获取 taskkill 杀进程命令模板
- **WHEN** 运行平台为 Windows，`shellKind` 为 `powershell` 或 `cmd`
- **THEN** Plan 的 `platformOptions.killCommand` 为 `['taskkill', '/PID', '{pid}', '/T', '/F']`

#### 场景: POSIX 平台获取 SIGKILL 杀进程策略
- **WHEN** 运行平台为非 Windows（Linux/macOS），`shellKind` 为 `posix`
- **THEN** Plan 的 `platformOptions.killCommand` 为 `null`，Engine 层使用 `process.kill(pid, 'SIGKILL')` 执行杀进程

### 需求: 配置层 defaultShellFamily 管理

系统必须（MUST）在终端配置模块中新增 `defaultShellFamily` 配置项，支持从持久化配置文件（JSON）和 `AGENT_DEFAULT_SHELL` 环境变量中读取，并提供运行时读写接口。

#### 场景: 从环境变量读取默认 shell family
- **WHEN** 环境变量 `AGENT_DEFAULT_SHELL` 设置为 `posix`，配置文件中未设置 `defaultShellFamily`
- **THEN** 系统默认 shell family 为 `posix`

#### 场景: 持久化保存默认 shell family
- **WHEN** 调用 `saveDefaultShellFamily('posix')` 保存默认 shell family
- **THEN** 配置文件中的 `defaultShellFamily` 字段被写入 `posix`，且后续 `loadDefaultShellFamily()` 读取结果也为 `posix`
