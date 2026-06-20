# Walkthrough - windows-monitoring-timeout

本项目对 Windows 监控服务在 IJIA Agent 中调用发生的超时问题进行了彻底的架构优化与代码修复，并针对交互层出现的 Stdin 抢占及输入阻塞缺陷实施了全面修正。

## 变更明细

### 1. 系统与网络监控的高速、免特权重构
- **psutil 降级免权替代**：重写了 `system_monitor.py`，彻底移除了高耗时的 `win32pdh`，全面采用 `psutil`，将系统指标检索耗时降至 10ms 左右。支持安全捕获无特权系统进程报错，实现免管理员权限稳定运行。
- **子进程多进程解耦**：将基于 `pyetwkit` 的 ETW 流量采集功能剥离为独立的子进程 `etw_collector.py`，完全规避了 Python 的 GIL 锁挂起问题。

### 2. 子进程生命周期保障与优雅降级
- **Windows Job Object 强杀绑定**：在主进程 `etw_monitor.py` 中引入 Windows Job Object API，配置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。确保在主进程异常退出或崩溃时，操作系统物理强制清理子进程，杜绝后台残留。
- **隔离 stdin 输入抢占**：启动子进程时显式声明 `stdin=subprocess.DEVNULL`，阻断子进程继承并抢占控制台输入流。
- **动态死亡检验与静默降级**：在聚合流量入口实现对子进程 `poll()` 状态的动态健康查询，发生非管理员报错或异常闪退时优雅退化为仅提供系统性能查询，保障 MCP 稳定性。

### 3. 简体中文中文化翻译
- 将监控服务全部五个核心 Python 文件中的 `sys.stderr`、交互返回 JSON 错误信息、初始化调试日志全部改写为简体中文，确保与用户提示词风格和工程规范高度一致。

### 4. 调试修正：控制台交互卡死与提示符提前闪现
- **输入流 Stdin 静默暂停唤醒**：在 `CliFacade.ts` 的 `registerApprovalHandler` 回调中，针对由于旧 `readline` 关闭所致的 `process.stdin` 暂停问题，在创建新的临时 `readline` 实例前，显式调用 `process.stdin.resume()` 强行恢复输入流，解决了多卡关审批下输入卡死必须按回车换行的问题。
- **监听器重建延迟激活**：扩展 `InputListener.start(paused)` 支持可选的 `paused` 参数。在安全拦截审批的回调收尾重建时执行 `this.listener.start(true)`，使其保持挂起状态，消除在推理生成中抢占 `stdin` 和提前闪烁 `用户 [xxx] >` 提示符的问题。生成完全结束后由 `finally` 中固有的 `resume()` 方法统一唤醒。

### 5. 调试修正：僵尸进程自毁与文件锁死修复
- **防 PID 重用父进程存活看门狗 (Watchdog)**：在监控服务主进程 `main.py` 和子进程 `etw_collector.py` 启动时，开启基于 `psutil` 的轻量级心跳监测线程。为了彻底杜绝由于 Windows 操作系统高频回收和重新分配 PID（PID 重用）导致看门狗误判新启动的进程为父进程的情况，看门狗在初始化时不仅记录父进程 PID，还安全记录了父进程的启动时间（`create_time`）。守护线程以 2 秒频率轮询父进程，一旦发现 PID 不存在、PID 被重用为新进程（`create_time` 不匹配）、或进程不再处于运行状态，当前 Python 进程会立即调用 `os._exit(0)` 进行快速自毁。
- **文件句柄释放**：看门狗自毁机制不仅保证了主进程和子进程彻底退出不滞留，同时也使得它们持有的 `etw_raw_events.log` 等日志及系统句柄能够被操作系统内核及时自动回收和释放，彻底消除了日志文件无法删除的死锁问题。

## 验证结果

- **Lint 校验**：运行 `npm run lint` 验证通过。
- **测试回归**：运行 `npm run test` 所有 15 个测试文件中的 81 项用例全部成功通过（Passed 100%）。
- **进程自毁与清理验证**：在根目录下通过强杀父进程模拟客户端断开，针对 Windows PID 极速重用情境进行了防御验证，主 Python 进程 `main.py` 以及子进程 `etw_collector.py` 均在 2 秒内安全退出了后台，且被占用的 `etw_raw_events.log` 成功被物理删除，完美解决了僵尸进程堆积及文件锁死。
