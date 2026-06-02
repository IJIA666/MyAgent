## 改造原因

当前 `simple-agent-core` 引擎在 `src/tools.ts` 中直接硬编码了 Node.js 原生的文件读写工具（`readFile`、`writeFile` 等）。这种实现导致大模型推理循环与宿主执行环境（Host Environment）强物理耦合，极大地限制了未来引擎向纯前端或其他异构环境迁移的能力。此外，系统目前存在“本地函数调用”与“远端 MCP 调用”并存的两套独立工具标准。我们希望保留“开箱即用”特性的同时，在架构底层将调用标准统一化。

## 变更内容

- 移除 `src/tools.ts` 中针对文件读写的暴露接口，将其重构为独立的 `LocalFileSystemMcpServer` 抽象类。
- 在 `SessionManager` 内部，针对该虚拟 MCP Server，提供基于进程内通信或对象直接调用的短路适配，确保不真正拉起子进程。
- **BREAKING**: Agent 内部的 Tool Registry 系统可能被精简为纯粹管理 MCP 代理的管理器。

## 业务能力

### 新增业务能力
- `virtual-mcp-server`: 提供进程内模拟 MCP 协议交互的基础设施层。

### 修改业务能力
- `simple-agent-core`: 将底层工具集的集成方式统一切换为 MCP 协议标准，消除本地与远端工具在架构上的二元化。

## 影响范围

- `src/tools.ts`: 负责本地文件操作的工具函数将被迁移并封装。
- `src/session.ts`: 获取与调用工具的代码流转路径发生改变。
- `src/mcp-client.ts`（若涉及）: 可能需要扩展对“内存级/进程内 Server”的路由直连支持。
