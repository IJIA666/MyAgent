## 新增需求

### 需求: 强制执行复合命令逐节点分析与反休眠

系统 MUST 通过已决议 Shell family 对复合终端命令进行结构化分析，并对条件链、管道段、重定向、后台执行和嵌套命令逐节点生成权限证据。任一节点 deny 时整体 MUST deny，任一节点 ask、unknown 或 unsupported 时整体 MUST ask，只有全部节点 allow 时整体才可 allow。系统不得使用一个跨 Shell 字符正则代表完整语义，也不得在授权后使用第二次解析结果拒绝已经批准的同一调用。

Plan 模式、其他权限模式和执行期 MUST 消费权限阶段生成的同一份命令分析证据。任何 hardline 或 deny 证据 MUST 在所有模式下保持拒绝，且不得被解析降级、人工询问或 allow 规则覆盖。后台命令 MUST 进入现有任务托管、取消、超时和进程树清理生命周期。

#### 场景: Bash 只读复合命令全部通过

- **WHEN** 模型提交由已启用连接符或纯读取管道组成的有效 Bash 命令，且所有命令节点和资源均为 allow
- **THEN** 系统 MUST 保留 Shell 执行语义并允许整条复合命令进入执行

#### 场景: PowerShell 复合命令包含写入

- **WHEN** 模型提交包含 PowerShell 条件链、管道或重定向，且其中至少一个节点需要 ask
- **THEN** 系统 MUST 对整条复合命令只发起一次 ask，并展示受影响的子命令和资源证据

#### 场景: 合法但未支持的复杂结构

- **WHEN** 模型提交语法有效但当前能力开关关闭或解析器无法完整覆盖的结构，且未命中 hardline
- **THEN** 工具 MUST 返回 ask；只有当前调用获得明确批准后才可执行，并且不得生成宽泛的持久 allow 规则

#### 场景: 正常命令参数中包含被当前 Shell 引用的操作符

- **WHEN** 模型提交 `git log --grep="feat;fix"` 或语义等价的有效原子命令
- **THEN** 对应 Shell 分析器 MUST 将引号内操作符识别为字面量，并允许该原子命令继续进入权限流程

#### 场景: 不支持结构中的 hardline 操作

- **WHEN** 任一已解析节点、未支持结构或语法无效输入中包含 Git 写操作或其他不可绕过的 hardline 操作
- **THEN** 最低限度 deny 扫描 MUST 使最终结果保持 deny，不得因分析状态降级而转成 unknown 或可批准的 ask

#### 场景: Plan 模式和执行期复用同一分析证据

- **WHEN** 系统在 Plan 模式下评估终端命令并在授权后进入执行期
- **THEN** 权限服务和执行器 MUST 复用同一份节点与聚合证据；unsupported 不得在 Plan 中自动执行，执行期也不得再次解析造成审批后拒绝或副作用漂移

#### 场景: 重定向目标参与权限决策

- **WHEN** 命令通过输入、输出、追加或错误流重定向访问静态文件目标
- **THEN** 系统 MUST 把目标作为 read/write 资源参与整体权限聚合，动态或无法确定的目标 MUST 至少 ask

#### 场景: 后台命令进入托管生命周期

- **WHEN** 已启用的后台操作符使命令脱离前台等待
- **THEN** 系统 MUST 为其建立可查询任务、取消信号、超时和进程树清理关系；无法建立关系时 MUST ask/deny，不得自动 allow

#### 场景: 单批能力可以独立回退

- **WHEN** 管道、条件链、重定向、后台或嵌套中的任一能力开关被关闭
- **THEN** 仅对应结构 MUST 回退为 unsupported/ask，其他已启用结构和统一权限聚合行为 MUST 保持不变

### 需求: 工作区沙箱路径锁死 (Sandbox CWD)
系统在启动进程前，必须解析并验证传入的 `cwd` (当前工作目录) 参数。该路径必须严格限定在当前项目的根工作区目录之下。

#### 场景: 模型企图读取或修改非授权目录
- **WHEN** 代理使用 `cwd` 指定路径为 `C:\Windows\System32` 或越界使用 `..\..\`
- **THEN** 终端执行引擎的沙箱路径解析器识别到路径脱离工作区，立即阻断运行并返回 `Operation not permitted (Out of bounds)`。

### 需求: 长时运行任务的流式保护与截断
系统必须实时截取命令的 `stdout` 和 `stderr` 输出。针对输出过长的日志，内存仅缓存最近及头部摘要内容，超限的日志完整内容必须后台溢写写入临时磁盘日志中，最终仅返回摘要和日志路径给模型。

#### 场景: 编译任务输出了超量日志文本
- **WHEN** 命令疯狂输出超大日志，内存缓存到达预设防爆上限
- **THEN** 系统保留最早和最新的日志摘要段落，将完整内容源源不断追加至临时日志文件。执行结束后，给模型返回被截断的内容，并在结尾附上标准化的 `<shell_metadata>` XML 标签（包含退出码、耗时、完整日志路径等信息）供模型精准解析。

#### 场景: 同步命令快速完成

- **WHEN** `execute_command` 以同步模式运行的命令在自动后台化阈值前完成
- **THEN** 系统必须只通过该工具调用的 tool result 返回执行结果，不得额外向会话注入 `<system_notification>`，以保持 assistant tool call 与 tool response 的消息顺序闭环。

#### 场景: 后台托管命令完成

- **WHEN** `execute_command` 以显式后台模式运行，或同步命令超过自动后台化阈值后被移交后台托管
- **THEN** 后台任务完成、卡死或命中特征行时，系统应通过 `EventNotificationPort` 注入 `<system_notification>`，由核心会话执行异步唤醒。

### Requirement: 终端 advisory warning 必须按 shell 语义解析参数

系统在为终端结果生成 `<advisory_warnings>` 时，必须按已决议的 shell family 区分命令开关与真实路径。告警解析不得把 Windows `cmd` 的 `/A:H`、`/W` 等开关参数解释成外部路径，也不得因此制造不存在的跨盘或越界访问告警。

#### 场景: cmd dir 开关不产生路径误报

- **WHEN** 模型以 `shellKind: "cmd"` 调用 `execute_command` 执行 `dir C:\ /A:H /W`
- **THEN** advisory warning 最多针对真实的 `C:\` 路径生成提示，不得生成 `A:\H`、`D:\W` 或其他由开关参数派生的虚假路径告警。

#### 场景: 真实绝对路径仍被提示

- **WHEN** 命令参数包含明确的 Windows 绝对路径或 UNC 路径，且路径位于授权工作区之外
- **THEN** advisory warning 必须继续记录该外部路径的摘要提示，不得因跳过开关参数而关闭真实路径提示。

### 需求: 僵尸进程树强杀
如果在命令执行超时（或发生无输出死锁超时），系统必须能够彻底清除该环境衍生出的所有子孙进程（例如通过 npm start 调起深层 node 脚本的场景）。

#### 场景: 衍生任务卡死超时
- **WHEN** 任务运行超过设定的 `timeoutMs` 或持续无输出时间超过 `noOutputTimeoutMs`
- **THEN** 系统判定超时，并底层调用 Windows 特有命令 `taskkill /PID <pid> /T /F`，安全且干净地切除整颗孤儿进程树。

### 需求: 控制台中文乱码防御
在执行涉及 PowerShell 的终端指令时，必须前置设置控制台输出的编码格式，以保障中文或其它多字节文本能够被正确回传和解析，避免产生乱码（Mojibake）。

#### 场景: 终端返回含有中文字符的输出
- **WHEN** 代理使用系统终端工具输出或接收中文字符串
- **THEN** 因系统底层隐式注入了 `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8` 环境声明，返回的结果完全正确展示中文字符，未出现乱码。

### 需求: Windows Npm 漏洞级脚本执行修复
由于我们强制禁用 `shell: true`，在较新的 Node 环境（修复了 CVE-2024-27980 的版本）下，直接 spawn Windows 批处理文件（如 `.cmd`, `.bat`）会导致内核级 `EINVAL` 报错。系统必须底层介入并重写 npm/npx 命令路径。

#### 场景: 代理执行 npm 安装命令
- **WHEN** 代理发起执行 `npm install` 命令
- **THEN** 系统拦截并将执行路径映射为其底层的 js 文件（如 `node.exe path/to/npm-cli.js install`），完美绕过 `EINVAL` 崩溃，命令成功执行。

### 需求: 智能阻塞降级 (Auto-Backgrounding)
当模型以同步模式启动了一个需要长时间运行的任务时，系统不应长时间挂起线程阻碍代理思考。必须在设定的等待预算（如 15 秒）到达时，自动将任务切入后台托管，并向模型返回接管通知。

#### 场景: 安装海量依赖导致同步等待超标
- **WHEN** 代理同步运行 `npm install`，耗时超过 15 秒仍未结束
- **THEN** 终端引擎自动解除同步挂起，返回一条通知语（如 `命令尚未结束，已自动转入后台运行，Task ID 为 xxx`），而后台进程继续执行不受影响。

### 需求: 启动瞬时异常后台捕获
对于设定为后台长期运行的命令，不应立即切断监听。系统必须给予它一个短暂的"存活观察期"（如 200ms），如果在这段时间内发生立刻崩溃的异常，必须直接截获错误并同步反馈给请求者。

#### 场景: 拼错命令导致立即崩溃
- **WHEN** 代理发起一个 `npm run un-exist-script` 命令并将其标识为后台运行（is_background）
- **THEN** 引擎在其启动的最初 200ms 内监控到了 `exit 1` and 报错，立刻将该任务视为启动失败，同步抛出包含 `stderr` 的错误，而非静默进入后台。

### 需求: 终端 Git 写操作绝对阻断
系统为了严格恪守只读安全边界，必须在最底层绝对阻断任何改写仓库或涉及文件变更的非只读 Git 指令。
1. **阻断子命令列表**：包括但不限于 `add`, `commit`, `checkout`, `reset`, `push`, `pull`, `rebase`, `merge`, `stash`, `revert`。一旦检测到核心命令以 `git` 开头且紧随这些写操作子命令，网关必须直接阻断抛错。
2. **全模式硬拦截**：该卡关规则属于不可豁免的硬底盘阻断，哪怕系统处于 bypassPermissions 模式，或 auto 模式下人工确认批准，也均直接强制拒绝执行，杜绝安全红线突破。

#### 场景: 模型在 bypassPermissions 或 auto 模式下企图执行 git commit 变更操作
- **WHEN** 模型在 bypassPermissions 模式下试图调用终端工具执行 `git commit -m "update"`
- **THEN** 安全网关自动识别该核心命令属于 Git 写变更操作，触发绝对阻断拦截，抛出安全红线异常并直接拒绝执行。

### 需求: execute_command 工具新增可选 shellKind 参数

系统必须（MUST）在 `execute_command` 工具的 JSON Schema 参数定义中新增可选的 `shellKind` 字段。其取值为 `auto | posix | powershell | cmd` 字符串枚举，默认值为 `auto`。该变更必须保持接口兼容：现有调用方无需修改即可继续调用该工具；当模型未传入此参数时，系统按 `auto` 的既定分辨率决议 shell family。

原需求定义位于 `terminal-tool` 的 `execute_command` 工具声明部分，此处为增量修改：在 `parameters.properties` 中追加 `shellKind` 字段。

#### 场景: 模型显式指定 shellKind
- **WHEN** 模型调用 `execute_command` 时传入 `shellKind: "posix"` 及命令 `ls -la`
- **THEN** 系统使用 POSIX shell 语义执行命令，安全网关按 POSIX 规则进行命令解析与安全校验

#### 场景: 模型未指定 shellKind（向后兼容）
- **WHEN** 模型调用 `execute_command` 时未传入 `shellKind` 参数
- **THEN** 系统使用 `auto` 默认值进行 shell family 分辨率，且工具接口对现有调用方保持兼容；是否与改造前的具体平台执行语义完全一致，由 `auto` 的平台默认策略决定并在设计中单独说明

#### 场景: 显式指定不受支持的 shellKind
- **WHEN** 模型调用 `execute_command` 时显式传入 `shellKind: "powershell"`，但当前环境不支持 PowerShell
- **THEN** 工具返回清晰的 shell 不受支持错误，且不得静默改用其他 shell 执行该命令
