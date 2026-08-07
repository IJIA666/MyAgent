# subagent-execution Specification（增量）

## Purpose

本文件是 `openspec/specs/subagent-execution` 主干规范的增量补丁：2b 明确子代理内联 MCP 连接属于子代理拥有的资源（随其结束关闭），引用型连接属于借用资源（不关闭）。其余主干需求保持不变。

## MODIFIED Requirements

### Requirement: 子代理资源不得关闭父会话资源

系统 SHALL 明确区分子代理拥有的资源与借用的父资源。子代理结束时 MUST 关闭自身上下文、LLM 客户端、插件和登记，但 MUST NOT 关闭父工具注册表、父 LLM 客户端或共享 MCP 连接。内联 MCP 连接（定义级 `mcpServers` 内联声明动态建立）MUST 视为子代理自有资源，随子代理结束关闭；引用型 MCP 连接 MUST 视为借用的父资源，不得关闭。

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
