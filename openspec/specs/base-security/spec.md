## Purpose

定义工具访问物理路径、授权根和终端副作用时必须遵守的基础安全边界。该规范同时约束执行前判断与执行期校验，防止字符串前缀、符号链接或临时授权扩大真实可访问范围。
## Requirements
### Requirement: 物理路径去模糊与防逃逸
系统必须（MUST）在授权和执行前解析现有父目录的真实路径，并验证高层文件 API 的目标位于授权工作区物理根或显式注入的当前项目 `ApplicationPaths.memoryDir` 物理根内。`memoryDir` 例外只能（MUST）授予标准高层文件 API，不得（MUST NOT）扩大到其父级 `projectDataDir`、其他项目目录或 terminal cwd。terminal cwd 必须（MUST）继续位于授权工作区物理根内。不存在的写入目标必须（MUST）通过最近现有父目录进行物理路径校验。

#### Scenario: 工作区内正常读写
- **WHEN** 智能体试图读取工作区内的相对路径文件 `./package.json`
- **THEN** 路径校验器校验成功，将路径解析为对应的真实物理绝对路径，并允许文件操作执行。

#### Scenario: 标准文件工具访问当前项目 memoryDir

- **WHEN** 高层文件 API 的目标解析后位于显式注入的当前项目 `memoryDir` 物理根内
- **THEN** 路径边界校验允许该目标继续进入正常 effect、`PermissionMode` 和审计流程

#### Scenario: 访问 memoryDir 的相邻项目数据目录

- **WHEN** 高层文件 API 的目标位于当前项目 `projectDataDir` 下但不位于 `memoryDir` 内
- **THEN** 系统拒绝该访问

#### Scenario: 访问其他 workspace-key 的记忆目录

- **WHEN** 高层文件 API 的目标位于另一个项目的 `memoryDir`
- **THEN** 系统拒绝该访问

#### Scenario: 通过符号链接逃逸授权根

- **WHEN** 词法路径位于工作区或 `memoryDir` 内但真实路径解析到对应授权根之外
- **THEN** 系统拒绝该访问

#### Scenario: 不存在的写入目标通过父目录逃逸

- **WHEN** 写入目标尚不存在且其最近现有父目录的真实路径位于对应授权根之外
- **THEN** 系统拒绝该写入

#### Scenario: terminal cwd 指向 memoryDir

- **WHEN** terminal cwd 位于工作区外的当前项目 `memoryDir`
- **THEN** 系统拒绝该 cwd

#### Scenario: 软链接沙箱逃逸拦截
- **WHEN** 工作区内存在一个符号链接 `./link_to_system` 指向外部 `C:\Windows`，智能体试图读取 `./link_to_system/system.ini`
- **THEN** 路径校验器通过 `fs.realpathSync` 展开发现真实物理路径为 `C:\Windows\system.ini`，判定其溢出安全边界，抛出拒绝访问的错误强行拦截。

### Requirement: 终端写倾向命令拦截与安全降级

系统必须（MUST）基于已决议 shell family、解包后的核心命令、参数结构和可信只读规则，将终端操作分类为可证明只读、敏感读取、写入、未知副作用或硬红线。审批不得替代静态安全判定。在 `Plan` 模式下，可静态证明无副作用且不涉及敏感资源的原子只读命令必须直接放行；敏感读取必须进入受限审批；写入、未知副作用、复合脚本和硬红线命令必须拒绝。前置安全判定与执行期结构校验必须在允许集合上严格同构。

#### Scenario: 所有模式下可证明安全的只读命令静默放行

- **WHEN** 智能体执行命中可信只读规则、参数结构有效且不涉及敏感资源的原子命令
- **THEN** 系统必须将操作判定为 read 并直接放行，不得仅因工具为通用终端而要求人工审批

#### Scenario: Plan 模式原子系统查询静默放行

- **WHEN** 智能体在 Plan 模式执行参数受限且可静态证明无副作用的系统查询
- **THEN** 系统必须直接执行并把实际 effect 记录为 read，不生成审批请求

#### Scenario: 敏感只读操作仍需受限审批

- **WHEN** 一个语法只读的命令会读取凭据文件、敏感配置或其他受保护资源
- **THEN** 系统必须将其分类为 sensitive-read，并仅提供单次放行或拒绝，不得静默放行或持久授权

#### Scenario: 危险写倾向命令降级审批

- **WHEN** 智能体在允许写入的工作模式执行未命中硬红线的写倾向命令
- **THEN** 系统必须挂起执行，展示标准化操作、实际核心命令和风险范围，等待用户裁决

#### Scenario: Plan 模式拒绝写入与未知副作用

- **WHEN** 智能体在 Plan 模式执行写入、未知副作用、复合连接、重定向、环境变量展开或脚本化命令
- **THEN** 系统必须直接拒绝并返回与实际注册工具一致的自愈引导，不得进入审批

#### Scenario: 硬红线命令在任何模式直接拒绝

- **WHEN** 命令命中系统破坏性硬红线
- **THEN** 系统必须直接拒绝且不得提供任何放行选项

#### Scenario: 前置判定与执行期校验同构

- **WHEN** 任意终端调用通过前置安全判定
- **THEN** 执行期必须复用同一 shell 计划与结构约束；前置拒绝的调用不得进入审批或执行

### Requirement: Authorized Roots Distinguish Workspace Memory and Additional Directories

执行期路径解析 MUST 分别维护物理 workspace 根、精确默认/custom memory 根和 session additional directories，并按操作类型验证。任何父目录或字符串相似前缀 MUST NOT 因子根授权而可达。

#### Scenario: Default memory is initialized

- **WHEN** 应用初始化当前项目 memory 根
- **THEN** 路径边界 MUST 只允许其精确物理子树
- **THEN** `.myagent` 父目录和其他项目数据 MUST 保持范围外

#### Scenario: A non-existing child is resolved

- **WHEN** 目标尚不存在
- **THEN** 系统 MUST realpath 最接近的已存在祖先并安全拼回剩余部分
- **THEN** symlink/junction MUST NOT 逃逸授权根

### Requirement: Execution Revalidates Approved Physical Resources

执行器 MUST 将计划中的物理资源身份与执行前解析结果比较。路径、symlink、junction、挂载或大小写身份发生变化时，原 grant MUST 失效。

#### Scenario: A symlink is swapped after approval

- **WHEN** 文件批准后 symlink 被替换为指向范围外目标
- **THEN** 执行期复核 MUST 拒绝

### Requirement: Legacy Temporary Whitelists and Call Claims Are Removed

`secureResolveReadPath`/`secureResolveWritePath` MUST 只消费当前 execution plan、正式 additional directories 和静态授权根。生产路径 MUST NOT 查询 temporary read/write whitelist、claimed resource 或 CallCapability。

#### Scenario: A legacy whitelist entry exists in restored state

- **WHEN** 旧会话数据包含 temporary whitelist 或 claimed resource
- **THEN** 新路径解析 MUST 忽略该状态
- **THEN** 访问 MUST 根据当前 PermissionSessionState 重新授权
