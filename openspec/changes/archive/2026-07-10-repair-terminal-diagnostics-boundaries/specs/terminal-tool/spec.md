## MODIFIED Requirements

### Requirement: 长时运行任务的流式保护与截断

系统必须实时截取命令的 `stdout` 和 `stderr` 输出。针对输出过长的日志，内存仅缓存最近及头部摘要内容，超限的日志完整内容必须后台溢写写入临时磁盘日志中，最终仅返回摘要和日志路径给模型。

#### 场景: 编译任务输出了超量日志文本

- **WHEN** 命令疯狂输出超大日志，内存缓存达到预设防爆上限
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
