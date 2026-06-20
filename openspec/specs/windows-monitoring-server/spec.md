## 新增需求

### 需求: 管理员权限 Fail-Fast 检测校验
在 Windows 下启动系统监控服务时，程序必须(MUST)自动检测当前是否拥有 Administrator 权限。如果权限不足，程序必须(MUST)通过 `sys.stderr` 输出致命错误信息，并以非零状态码退出，而不应该试图进行异步提权，以防止损坏 Stdio 通信管道。

#### 场景: 非管理员用户启动服务触发 Fail-Fast 报错
- **WHEN** 服务端入口脚本在非管理员权限的用户上下文中被启动
- **THEN** 程序拦截初始化流程，向 stderr 打印 "[Fatal] System monitoring server requires Administrator privileges. Please run Agent with administrative elevation." 错误，并以状态码 1 退出进程

---

### 需求: 时间窗口流量聚合与接口输出
监控服务 must (MUST) 在内存中实时订阅 ETW 网络事件并累计流量。当客户端（Agent）调用查询工具时，服务 must (MUST) 按照设定的时间窗口（例如过去 5 秒）进行聚合，计算速率（Bytes/sec），且仅返回上传或下载流量排名前 N 的精简 JSON 报告。

#### 场景: 客户端调用网络带宽诊断工具
- **WHEN** 客户端向服务端发起 `get_network_traffic` 且携带参数 `window_seconds=5` 和 `top_n=5`
- **THEN** 服务端汇总过去 5 秒内所有 PID 的收发数据量，计算每秒带宽速度，将 PID 关联上对应的进程名称，并按总速率降序排列返回前 5 个进程的 JSON 数组

---

### 需求: 进程生命周期监听与 PID 映射缓存
监控服务 must (MUST) 监听 `Microsoft-Windows-Kernel-Process` ETW 事件，动态跟踪进程的创建和销毁，并在内存中维护 PID 到进程信息的 LRU 缓存，以保证流量瞬发进程能够被准确追溯进程名。

#### 场景: 瞬发进程爆发网络流量并立刻退出
- **WHEN** 一个生命周期仅 1 秒的进程启动、产生大量网络数据包发送事件并随后被销毁
- **THEN** 服务的进程监听器在进程启动时立即将 PID 和进程名写入 LRU 缓存；在网络事件触发时，通过 LRU 缓存成功匹配并输出正确的进程名，而不是返回未知进程 (Unknown)

---

### 需求: 系统性能计数器诊断
监控服务 must (MUST) 提供暴露系统 CPU、内存和磁盘 I/O 精细度指标的工具，包括内核态/用户态 CPU 时间、页面错误率、非分页池大小、物理/虚拟内存提交以及磁盘排队长度。

#### 场景: 客户端调用系统资源诊断工具
- **WHEN** 客户端向服务端发起 `get_system_resources`
- **THEN** 服务端调用 Windows Performance Counters API，获取当前 CPU 的上下文切换率、物理内存 Working Set、虚拟内存 Commit Size、非分页池/分页池字节数、磁盘读写字节速率以及磁盘队列长度，并将其结构化为 JSON 数据返回
