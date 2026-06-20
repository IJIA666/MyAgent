## 新增需求

### 需求: 监控服务 stdio 连接配置
客户端必须(MUST)在配置文件中提供 `monitoring-server` 的启动声明，使 Agent 在初始化时能够自动唤起该 Stdio 监控子进程，并将监控工具动态注入 Agent 的 Tool 注册表。

#### 场景: Agent 初始化时成功自动连接监控服务
- **WHEN** Agent 正常启动，且 `mcp_config.json` 中配置了 `monitoring-server` 的 Stdio 启动命令
- **THEN** Agent 成功拉起 Python 子进程，完成 Stdio 管道握手，成功动态加载并暴露 `get_network_traffic` 与 `get_system_resources` 两项外部工具

---

### 需求: 管理员权限缺失的友好警告拦截与优雅降级
当外部 Stdio 监控子进程启动失败或异常退出时，客户端必须(MUST)对其 stderr 输出流进行监听；如果错误日志匹配到管理员权限不足的关键字（"requires Administrator privileges"），Agent 必须(MUST)拦截崩溃，阻止无休止的重启，将该服务标记为禁用状态并允许客户端其他模块正常启动，同时在终端 Cli 主界面以红色醒目日志提示用户需以管理员身份重新运行 Agent。

#### 场景: 非管理员运行 Agent 触发监控服务端崩溃时的友好拦截与降级
- **WHEN** 用户以普通权限启动 IJIA Agent，且 Agent 尝试启动 `monitoring-server`
- **THEN** Python 子进程抛出特权不足错误并以退出码 1 退出；Agent 成功捕获到退出事件和 `sys.stderr` 里的错误内容，拦截报错，阻止主进程崩溃，并在 Cli 终端中打印红色警告 "[提示] 系统监控服务需要管理员特权，部分底层流量与性能监控功能已被自动禁用。若需使用，请以管理员身份重新启动命令行终端（PowerShell / CMD）运行 IJIA Agent。"，且 Agent 其余终端控制台输入输出功能正常使用
