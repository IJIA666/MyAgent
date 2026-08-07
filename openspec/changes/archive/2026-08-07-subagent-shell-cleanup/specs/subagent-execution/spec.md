## MODIFIED Requirements

### Requirement: 子代理资源不得关闭父会话资源

系统 SHALL 明确区分子代理拥有的资源与借用的父资源。子代理结束时 MUST 关闭自身上下文、LLM 客户端、插件和登记，但 MUST NOT 关闭父工具注册表、父 LLM 客户端或共享 MCP 连接。内联 MCP 连接（定义级 `mcpServers` 内联声明动态建立）MUST 视为子代理自有资源，随子代理结束关闭；引用型 MCP 连接 MUST 视为借用的父资源，不得关闭。子代理在其会话中启动的活跃 shell 任务（含 `isBackground` 驻留进程）MUST 视为子代理自有资源，随子代理结束（正常完成、失败或取消）回收**完整进程树**（平台 killCommand，非单 PID 降级）并完成**内部资源清理**（定时器、日志流与挂起 Promise 收敛），父会话 shell 任务 MUST 不受影响；回收为尽力语义，杀进程错误不向外传播、不掩盖子代理终态。

#### Scenario: 子代理结束后父工具仍可用

- **WHEN** `ScopedToolRegistry.close()` 或子代理清理流程执行
- **THEN** 父 `ToolRegistry` 保持打开
- **AND** 父会话随后仍可调用原生工具和已有 MCP 工具

#### Scenario: 内联 MCP 连接随子代理关闭

- **WHEN** 子代理声明内联 MCP 服务器且子代理正常完成、失败或取消
- **THEN** 该内联连接被关闭并回收子进程
- **AND** 清理发生在资源释放阶段（finally 语义），任何终态都不遗留内联连接

#### Scenario: 引用型 MCP 连接不被关闭

- **WHEN** 子代理声明引用型 MCP 服务器且子代理结束
- **THEN** 该连接保持可用（父会话与其他子代理继续共享）
- **AND** 不执行任何断开操作

#### Scenario: 子代理 shell 任务随子代理结束回收

- **WHEN** 子代理启动后台 shell 任务且子代理正常完成、失败或取消
- **THEN** 系统按子代理会话 ID 中止其登记的全部活跃 shell 进程（finally 语义）
- **AND** 以平台进程树回收语义结束进程：Windows taskkill /T 递归树、POSIX pkill -P 直接子进程 + 根进程 SIGKILL（孙进程为尽力回收的已知边界），父会话 shell 任务不受影响
- **AND** 任务内部资源完成清理：定时器关闭、日志流结束、挂起的执行 Promise 收敛

#### Scenario: 无中止能力时跳过清理

- **WHEN** 运行器未注入会话中止能力（测试或无终端环境）
- **THEN** 子代理结束不执行 shell 回收，其余清理与终态语义不变
