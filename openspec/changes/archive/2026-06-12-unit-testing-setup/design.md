## 背景

本系统采用纯 TypeScript 结合 ESM 模块规范。在先前的安全加固演进中，针对文件读写沙箱安全校验（`tools.ts`）与外部 MCP 客户端的生命周期注销（`mcp-client.ts`）添加了复杂的防线。由于缺乏系统化的自动化单元测试基础设施与外部依赖隔离模拟器，开发人员无法本地即时进行回归校验。同时在大脑决策层中，用于拼装大模型提示词队列的上下文适配器（`DefaultContextAdapter`）亦缺乏稳定性断言，其注入位置及顺序关系直接决定了消息在传输时的正确性。为解决上述工程隐患，本设计旨在引入 Vitest 测试框架，设计并搭建高内聚、零进程依赖的内存 Mock 测试骨架，并补齐上下文注入适配器的全量断言。

## 目标与非目标

**目标:**
- 引入 `vitest` 框架作为项目开发依赖（`devDependencies`）。
- 项目根目录配置 `vitest.config.ts` 以正确加载 TypeScript 源码，并排除不必要的文件。
- 在 `package.json` 的 `scripts` 中配置 `test` 命令。
- 针对 `src/action/tools.ts` 中的 `secureResolvePath` 函数编写覆盖全部安全攻击边界的单元测试（恶意路径遍历、绝对路径逃界、同前缀边界逃逸）。
- 针对 `src/action/mcp-client.ts` 中的生命周期管理编写单元测试，使用 `@modelcontextprotocol/sdk` 内建的 `InMemoryTransport` 进行内存级 MCP 消息分发拦截，断言优雅注销、3 秒优雅自毁、信号注销以及工具同名路由阻断拦截逻辑。
- 针对 `src/brain/adapters/DefaultContextAdapter.ts` 中的 `assemble` 方法编写高完整度的单元测试，覆盖不同消息形态下的拼装顺序与边界插入行为。
- 确保测试文件全部纳入 Git 版本控制。

**非目标:**
- **禁止修改核心业务代码**：本变更为纯测试与工程化配置搭建，不触碰或重构任何业务运行逻辑。
- **不为所有系统模块铺满测试**：测试范围严格锁定在 `src/action/tools.ts`、`src/action/mcp-client.ts` 以及 `src/brain/adapters/DefaultContextAdapter.ts`。
- **不实现自动化 CI 云端流水线配置**：仅确保在本地能通过标准的终端指令一键运行通过。

## 架构决策

1. **选用 Vitest 作为测试运行框架 (Why Vitest over Jest or node:test)**:
   - *理由*：与 Node.js 原生的 `node:test` 相比，Vitest 具备极其强大的 ESM 模块级 Mock 能力（如 `vi.mock`），使我们在将来模拟复杂的 OpenAI/DeepSeek 等外部接口时更加得心应手。与 `Jest` 相比，Vitest 不需要配置繁琐的 `ts-jest` 与 babel 转换，利用内置的 esbuild 提供秒级的 TypeScript 原生编译和极速的热更新体验，契合现代 ESM 项目架构。

2. **使用 InMemoryTransport 模拟 MCP 进程交互**:
   - *理由*：传统的测试中通常需要借助 Node.js 的 `child_process` 物理拉起外部的 Python 或 Node.js 的 MCP 服务进程，这不仅运行开销大（建立连接需要时间），且在测试用例崩溃时易发生子进程无法收回的僵尸进程风险。选用 `@modelcontextprotocol/sdk` 提供的 `InMemoryTransport` 可以在进程内存中将 Client 句柄与 Server 句柄直接桥接，使我们可以用 100% 确定性的方式在微任务中模拟 JSON-RPC 通信，断言客户端的命名空间冲突与优雅销毁时序。

3. **测试用例边界设计**:
   - **沙箱路径测试**：分别传入正常路径、恶意绝对路径（如 Windows system 路径）、相对穿越路径（如 `../../`）以及容易混淆的同前缀路径（如授权根目录为 `/authorized/path`，传入参数为 `/authorized/path-secret`），断言其是否能被 `secureResolvePath` 精准拦截并抛出错误。
   - **MCP 客户端测试**：构建两个虚拟的内存 MCP 服务端，注册重名工具并挂载至 `McpToolManager`，断言是否抛出预期的 `Error`。在关闭连接时，利用 spy 监听 `transport.close` 和 `process.off`，断言 3 秒优雅等待之后 `client.close` 是否被成功触发，以及全局信号是否被完整清理。
   - **上下文适配器测试**：对 `DefaultContextAdapter.assemble` 方法进行以下特定验证：
     - *无注入原样返回*：在没有传入临时技能和局部规则时，断言返回消息快照深拷贝与传入的基础历史一致。
     - *注入位置与顺序校验*：当同时存在局部规则和临时技能时，验证两者是否以特定顺序（局部规则在前，临时技能在后，且包裹在特定的 XML 标签中）组装，并精准插入到最后一条 `user` 角色消息的前面。
     - *空历史边界兜底*：在传入的消息历史中没有任何 `user` 消息时，断言注入的消息是否会被安全地追加到整个消息数组的最尾端以进行容错保护。

## 风险与权衡

- **[风险点] 外部依赖 node_modules 膨胀** -> *缓解策略*：所有测试包（`vitest` 及其依赖项）仅在 `devDependencies` 声明，且项目在最终的 `npm run build` 打包发布时不将测试依赖打入 `dist/` 生产包。
- **[风险点] 信号监听残留与警告** -> *缓解策略*：在每个测试套件的 `afterEach` 或 `after` 生命周期中，强制触发 `manager.close()` 并清除所有的 timers，防止用例之间残留的退出监听器引发 `MaxListenersExceededWarning`。
