# 架构设计：六边形架构规范化与隐式耦合解耦

## 背景

当前系统的六边形物理分层并未真正达成契约层面的隔离，呈现“物理划分、实质强耦合”的状态。
- **反向物理依赖（核心直接依赖具体适配器）**：核心层的 `SessionManager` 及 `AgentLoop` 显式 `import` 并构造了 `adapters/` 层面的 `ToolRegistry`、`McpToolManager` 等类。
- **环状依赖物理链条**：外部插件（`TokenWatermarkPlugin`、`JitRulesPlugin`、`HumanApprovalPlugin`）依赖核心服务（`CompactionService`、`ToolDispatcher`、`SecurityService`、`ApprovalService`），而核心用例 `SessionManager` 在初始化时又硬编码去 `new` 这几类插件。
- **接口隔离原则（ISP）失效**：胖接口 `SessionEventPort` 将会话信息、状态获取、事件通知及高危用户审批（`waitApproval`）杂糅在一个契约中，导致仅需执行基础 I/O 的文件、终端工具被迫依赖此大接口。
- **SecurityService 泄露**：终端和工具基类中直接调用核心层全局单例 `SecurityService.getInstance()` 获取白名单，产生了适配器向核心的反向物理导入。

---

## 目标与非目标

### 目标

1. **策略物理归位（消除反向耦合）**：将 `TokenWatermarkPlugin`（水位压缩）、`JitRulesPlugin`（JIT 伴生规则）和 `HumanApprovalPlugin`（人机协同审批）从外围插件目录物理移入核心用例层 `src/core/usecases/` 目录中。因为它们本身即是核心大循环的内置防御和状态挂起规则，不应外包给适配器。
2. **彻底的依赖反转（DIP）**：
   - 核心层（`SessionManager` 和 `AgentLoop`）绝对不包含任何直接导入外围具体适配器类（如 `ToolRegistry`、`McpToolManager`）的 `import` 语句或物理实例化操作。
   - 声明 `ToolRegistryPort` 抽象契约。具体的 `ToolRegistry` 适配器只在系统物理入口 `src/index.ts` 中实例化并组装，再通过构造函数以接口形式注入核心。
3. **安全服务（SecurityService）解耦**：
   - 定义安全白名单的契约方法，具体工具完全通过 Port 接口获取安全白名单前缀，切断对核心 `SecurityService` 全局单例的直接物理导入。
4. **遵循接口隔离原则（ISP）精简契约**：
   - 将胖接口 `SessionEventPort` 进行细粒度拆分，使外部工具仅能感知对应功能的超薄端口。

### 非目标

1. **不引入重型依赖注入（IoC）框架**：本系统仅使用原生 TypeScript 提供的简洁**构造函数注入（Constructor Injection）**机制，避免给轻量级项目增添无关包依赖。
2. **不修改核心执行逻辑**：不改动 `AgentLoop` 生命周期状态机（FSM）转换规则，不重写 `plugin-runner` 引擎的核心逻辑。
3. **沿用既有机制**：对回收回核心的策略在与 `AgentLoop` 通信时，直接沿用原有的 `HookContext`，不新增额外的拦截上下文（InterceptorContext）抽象概念。
4. **不包含任何业务产品需求或交互功能特性的改动**。

---

## 架构决策

### 决策 1：水位压缩、即时规则和确权审批作为核心内置拦截器归位
- **决策内容**：将 `TokenWatermarkPlugin`、`JitRulesPlugin` 及 `HumanApprovalPlugin` 的源码文件物理迁移至 `src/core/usecases/`，不再作为外设插件存在。
- **理由**：这三类拦截插件代表了 Agent 的核心防御壁垒与状态挂起规则。物理移回 Core 内部后，它们可以直接合法引用核心的 `CompactionService`、`ToolDispatcher` 和 `ApprovalService`，彻底消除了为了“伪装成适配器”而被迫跨层级强耦合核心实体的环状依赖。

### 决策 2：建立 Tool 契约接口，实现入口装配 DIP
- **决策内容**：在 `src/ports/driven/` 下定义 `ToolRegistryPort` 契约，除提供获取和调用工具方法外，增加 `close(): Promise<void>` 以便生命周期回收。
- **DIP 实现**：具体的 `ToolRegistry`（它本身管理并持有 `McpToolManager`）实现 `ToolRegistryPort`。核心用例 `SessionManager` 只接收 `ToolRegistryPort`，完全与 `McpToolManager` 具体类和 `ToolRegistry` 具体类物理断开。
- **装配位置**：具体的组装和实例化操作移出核心，放在项目唯一的物理启动入口 **`src/index.ts`** 处。在 `src/index.ts` 中 `new ToolRegistry`，注入 `SessionManager` 后交由 `CliFacade` 运行。

### 决策 3：接口下沉定义，解耦 SecurityService 全局单例
- **决策内容**：在 `SessionContextPort` 契约中定义 `getSecurityAllowlist(): string[]` 抽象方法。具体工具基类（`base.ts`）与终端工具（`terminal.ts`）只通过 `sessionContext.getSecurityAllowlist()` 获取配置，不允许直接调用 `SecurityService.getInstance()`。
- **实现机制**：位于核心领域的实体 `SessionContext` 实现该接口，并在其内部调用核心服务 `SecurityService.getInstance().getSecurityAllowlist()`。这既保持了工具的无状态与接口隔离，也切断了适配器向核心单例类的物理导入。

### 决策 4：拆分 SessionEventPort，限制普通工具特权
- **决策内容**：将臃肿的 `SessionEventPort` 进行物理拆分：
  - `ApprovalPort`：专门承载 `waitApproval` 人机确权调用，被具体需要审批的高危工具单独引用。
  - `EventNotificationPort`：专门承载 `addNotification` 及 `emit` 异步派发，被需要唤醒大模型的工具引用。
  - `SessionContextPort`：承载 `getSessionId`、`getWorkMode` 等只读属性。
- **理由**：通过拆分，使文件系统等普通工具不再具有人机审批等不必要的高特权方法，满足接口隔离最小化原则。

---

## 风险与权衡

- **[风险 1] 单元测试的相对路径与签名破坏**：
  - *分析*：修改 `SessionManager` 的构造参数和拦截器的物理路径将导致现有 98 个单元/集成测试用例无法编译通过。
  - *缓解策略*：重构过程必须严守原子化和渐进式，先改签名、用 Mock 填充测试参数，直到全量测试再次通过，严禁长时间脱离编译通过状态。
- **[风险 2] 拦截器归位引入的二次环状依赖**：
  - *分析*：虽然移除了适配器向内依赖，但核心拦截器依然在插件通道中运行，可能有循环引用风险。
  - *缓解策略*：拦截器内部依赖通过构造函数入参传入，拦截器本身不应直接 `import` 外部主循环类。

---

## 物理文件变动细则

1. **[NEW]** [ToolRegistryPort.ts](file:///D:/Projects/MyAgent/src/ports/driven/ToolRegistryPort.ts)
   - 定义工具获取、调用及 close 关闭契约，核心主循环仅面向此接口。
2. **[NEW]** [ApprovalPort.ts](file:///D:/Projects/MyAgent/src/ports/driven/ApprovalPort.ts)
   - 专门隔离人机高危确权的审批接口。
3. **[NEW]** [EventNotificationPort.ts](file:///D:/Projects/MyAgent/src/ports/driven/EventNotificationPort.ts)
   - 专门隔离异步通知与事件派发的接口。
4. **[MODIFY]** [SessionEventPort.ts](file:///D:/Projects/MyAgent/src/ports/driven/SessionEventPort.ts)
   - 退化为仅包含基本会话属性（如 SessionId/TenantId/WorkMode）的只读属性接口。
5. **[MODIFY]** [session.ts](file:///D:/Projects/MyAgent/src/core/usecases/session.ts)
   - 移除对 `ToolRegistry`、`McpToolManager` 的导入和 `new` 操作，改用 `ToolRegistryPort` 契约作为构造参数。
6. **[MODIFY]** [agent-loop.ts](file:///D:/Projects/MyAgent/src/core/usecases/agent-loop.ts)
   - 构造参数 `toolRegistry` 修改为 `ToolRegistryPort` 契约，移除与适配器的直接物理导入。
7. **[MOVE]** `src/adapters/plugins/TokenWatermarkPlugin.ts` -> [TokenWatermarkPlugin.ts](file:///D:/Projects/MyAgent/src/core/usecases/TokenWatermarkPlugin.ts)
   - 物理移动并修改依赖导入。
8. **[MOVE]** `src/adapters/plugins/JitRulesPlugin.ts` -> [JitRulesPlugin.ts](file:///D:/Projects/MyAgent/src/core/usecases/JitRulesPlugin.ts)
   - 物理移动并修改依赖导入。
9. **[MOVE]** `src/adapters/plugins/HumanApprovalPlugin.ts` -> [HumanApprovalPlugin.ts](file:///D:/Projects/MyAgent/src/core/usecases/HumanApprovalPlugin.ts)
   - 物理移动至核心层，可以直接引用核心领域的 `SecurityService` 与 `ApprovalService`。
10. **[MODIFY]** [index.ts](file:///D:/Projects/MyAgent/src/index.ts)
    - 作为系统物理入口，物理实例化 `ToolRegistry` 并将其装配注入核心会话管理服务。
11. **[MODIFY]** [base.ts](file:///D:/Projects/MyAgent/src/adapters/tools/tools/base.ts) & [terminal.ts](file:///D:/Projects/MyAgent/src/adapters/tools/tools/system/terminal.ts)
    - 去除 `SecurityService.getInstance()` 的直接调用，改由 Port 接口提供的白名单获取方法完成安全审查。

---

## [调试修正] 2026-06-21 重构微调决策

1. **死循环防护插件与审计插件归位核心层**：
   - 决策：将 `TracerLogPlugin` 与 `LoopPreventionPlugin` 从 `src/adapters/plugins` 物理移回核心 `src/core/usecases/` 中。
   - 理由：彻底切断核心层 `session.ts` 向外导入外围适配器目录的任何 import。
2. **MCP 连接管理契约接口（McpManagerPort）建模**：
   - 决策：物理新建 `src/ports/driven/McpManagerPort.ts` 契约，由 `McpToolManager` 实现，并在 `ToolRegistryPort` 中声明 `readonly mcpManager?: McpManagerPort`；消除外围命令对具体类的 `as any` 类型强转逃逸。
3. **callTool 签名一致性对齐**：
   - 决策：修改 `ToolRegistryPort.callTool` 签名以包含 `ApprovalPort` 交集，即 `sessionContext?: SessionEventPort & ApprovalPort`。
