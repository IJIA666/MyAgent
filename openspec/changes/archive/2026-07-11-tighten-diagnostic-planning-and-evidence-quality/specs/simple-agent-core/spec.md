## MODIFIED Requirements

### Requirement: Agent 自动收集所有可用工具并调度

系统必须（MUST）通过一个专门的、独立于 `SessionManager` 的 `ToolRegistry` 来聚合和管理所有的 MCP 客户端和内置虚拟工具。`SessionManager` 不能再自行管理 MCP 连接或在内部进行工具映射，它只能通过调用 `ToolRegistry.callTool(name, args)` 来分发大模型发起的工具请求。
此外，`SessionManager` 在调度工具执行的迭代循环中，必须（MUST）对每一轮交互产生的工具调用（Tool Calls）指纹（即函数名与参数哈希）进行持续追踪与监控。如果检测到模型在同一轮（一次用户会话）的迭代流转中连续发起了超过 4 次完全相同的工具调用，则必须抛出包含 `HARD BLOCK` 的异常强行阻断死循环。
对于诊断、排障和磁盘清理建议类回合，系统还必须（MUST）额外追踪系统查询失败状态、目录枚举预算与证据等级提升情况；一旦系统查询失败后仍尝试升级命令复杂度，或继续枚举已无法提升证据等级，系统必须收敛后续规划，不得无限制地继续扩散工具调用。

#### Scenario: 发起对内部文件系统的 Tool Call

- **WHEN** 模型返回了一个 `tool_calls` 要求读取文件
- **THEN** SessionManager 必须将请求直接委托给 `ToolRegistry`。`ToolRegistry` 负责查找对应的内置虚拟 MCP Server 进行处理，并将标准结果返回给 SessionManager。

#### Scenario: 阻断重复工具调用的死循环 (Loop Prevention)

- **WHEN** 在单次交互的工具循环中，大模型对同一个文件 `nonexistent.txt` 连续执行了第 5 次完全相同的 `readFile` 工具调用（函数名及参数均与前 4 次完全一致）
- **THEN** SessionManager 必须中断当前 ReAct 迭代过程，不再调用 `ToolRegistry`，直接抛出 `HARD BLOCK` 异常以强行终止死循环，保护 Token 不被无限耗尽

#### Scenario: 系统查询失败后不再升级为复杂 shell 方案

- **WHEN** 诊断类回合中的一次系统查询已被拦截或失败，且模型下一步试图改写成更复杂的 shell 组合命令继续重试
- **THEN** 系统必须阻止该升级路径，改为回退到内置只读工具、要求用户缩小范围，或直接声明当前证据不足

#### Scenario: 目录枚举预算耗尽后停止继续扩散

- **WHEN** 诊断类回合已经连续扩展多个目录候选，但后续 `listFiles` 调用不再新增高价值证据，或已达到本轮枚举预算
- **THEN** SessionManager 必须停止继续扩散新的目录枚举，并把后续回合收敛到总结、声明不确定性或建议下一步测量
