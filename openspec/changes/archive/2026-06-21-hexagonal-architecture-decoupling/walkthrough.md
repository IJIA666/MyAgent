# 变更验收说明（Walkthrough）

本项目已顺利实施并完成了六边形架构规范化与解耦重构任务（变更标识 `hexagonal-architecture-decoupling`）。所有核心依赖已彻底反转，胖接口也被合理拆分隔离，并且全量单元/集成测试套件已回归通过。

## 变更内容摘要

1. **依赖注入装配落地**
   - 彻底移除了核心用例（`SessionManager`、`AgentLoop`）对外围具体适配器类（`ToolRegistry`、`McpToolManager`等）的直接物理依赖。
   - 改造了 `src/index.ts` 物理启动入口，在该处统一实例化具体的 `ToolRegistry` 并将其作为 `ToolRegistryPort` 注入 `SessionManager`。
   - 引入了 `DefaultContextAdapter` 作为 `ContextAdapter` 接口的具体实现并将其注入，以维持 `AgentLoop` 对上下文装配职责的安全解耦。

2. **接口隔离原则（ISP）拆分与签名对齐**
   - 物理拆分了 `SessionEventPort`，精简为仅包含基本会话只读属性与临时白名单查询的瘦契约。
   - 新建 `ApprovalPort`（专门承载 `waitApproval` 人机确权调用）和 `EventNotificationPort`（专门承载 `addNotification` 及 `emit` 异步派发）。
   - 升级了 `ToolRegistryPort.callTool` 签名契约以支持 `SessionEventPort & ApprovalPort` 交叉类型，与具体实现的契约完全对齐。
   - 改造了 `DeletePathTool.execute` 及 `ExecuteCommandTool.execute`，仅让它们依赖所需的 `ApprovalPort` 与 `EventNotificationPort`。

3. **适配器安全服务与 MCP 连接管理去耦**
   - 工具基类（`base.ts`）与终端工具（`terminal.ts`）完全去除了对核心 `SecurityService` 全局单例的直接引用，改由从 `SessionEventPort` 查询路径白名单与命令前缀白名单。
   - 新建了 `src/ports/driven/McpManagerPort.ts` 驱动契约，由 `McpToolManager` 适配器实现，并在 `ToolRegistryPort` 接口中暴露该类型属性。
   - 彻底消除了外围连接及状态展示命令（`mcp.ts` 和 `tool.ts`）中通过 `as any` 绕过类型安全直接访问内部 `mcpManager` 的强转，回归了强类型安全的 Port 隔离屏障。

4. **核心拦截插件物理完全归位**
   - 将 `TokenWatermarkPlugin`（水位监测）、`JitRulesPlugin`（即时规则）、`HumanApprovalPlugin`（人机确权）、`TracerLogPlugin`（Trace审计）与 `LoopPreventionPlugin`（死循环防御）五个拦截插件源码物理移至核心用例层 `src/core/usecases/` 下。
   - 核心会话管理器 `session.ts` 对它们的物理 `import` 引用转为了纯粹的同层相对物理导入，达成了“核心不依赖任何外设适配器路径”的六边形架构强约束。

5. **测试代码签名及导入路径对齐**
   - 修正了单元测试文件 `test/brain/plugins.test.ts` 与 `test/integration/safety-cascade-isolation.test.ts` 中对物理归位后的五大内置拦截器的相对导入路径。
   - 补全了 `test/session/loopback.test.ts` 中 `new SessionManager` 的实例化签名，向其注入了 Mock 版本的 `ToolRegistryPort` 和 `ContextAdapter` 桩实例，彻底清除了测试层面的类型警告与运行时错误。

## 验证与回归测试结论

### 静态编译检查
- 运行命令：`npx tsc --noEmit`
- 检查结果：没有输出任何类型警告或冲突，编译 100% 通过。

### 自动化单元与回归测试
- 运行命令：`npm run test`（Vitest 驱动）
- 检查结果：**20 个测试套件，98 个测试用例全部 100% 成功通过（全绿灯）**。
