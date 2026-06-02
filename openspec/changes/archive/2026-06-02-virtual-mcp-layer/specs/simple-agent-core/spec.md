## MODIFIED Requirements

### 需求: Agent 自动收集所有可用工具并调度
引擎的 Tool Registry 必须统一以 MCP 的规范来聚合所有可用工具，不再区分原生的本地函数与远端扩展能力。

#### 场景: 发起对内部文件系统的 Tool Call
- **WHEN** 模型返回了一个 `tool_calls` 要求读取文件
- **THEN** SessionManager 不再走特殊的本地反射分支，而是将请求直接交给对应的内置虚拟 MCP Server 进行处理，并能正确解析其返回的标准结构

## REMOVED Requirements

### 需求: 原生硬编码工具调用
**Reason**: 已被统一的虚拟 MCP 协议层替代
**Migration**: 相关逻辑已经迁移至 `LocalFileSystemMcpServer` 抽象，原有 `tools.ts` 中直接暴露给大模型的 `readFileTool` 等函数声明被移除。
