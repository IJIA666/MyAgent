# 提案：六边形架构规范化及隐式耦合解耦重构

## 改造原因

智能体系统在上一轮六边形架构迁移中虽然进行了物理目录层面的重新分配，但在编码实施上存在严重的“物理隔离、实质强耦合”问题。具体表现如下：
- **循环物理依赖**：核心层的 `SessionManager` 直接硬编码 `import` 并实例化了外围的 `ToolRegistry`、`McpToolManager` 等具体适配器类；而具体工具（如 `terminal.ts`、`base.ts`）与拦截插件（如 `TokenWatermarkPlugin`、`JitRulesPlugin`、`HumanApprovalPlugin`）反过来又直接引用了核心用例层的具体实现类（如 `SecurityService` 单例、`CompactionService`、`ToolDispatcher` 等）。
- **职责错置与插件边界模糊**：Token 水位校验、JIT 伴生规则组装、人机确权审批插件本质上属于智能体核心的领域决策规则，却被“外包”成为了外围插件。为了实现对应逻辑，它们不得不重新强耦合核心用例类，导致了严重的跨层级依赖纠缠。
- **胖接口依赖**：`SessionEventPort` 作为 driven 端口契约混杂了过多子职责，违反了接口隔离原则（ISP），导致外围工具无端感知核心状态。

本改造旨在纠正上述实施层面的设计缺陷，通过建立**“六边形外部防线 + 核心内部拦截管道”**的组合方案，彻底肃清物理循环依赖，精简接口，使各层职责清晰归位。

## 变更内容

本次技术性重构核心发生以下变更：
1. **策略归位与去强耦合**：将原本作为“外挂插件”的水位控制、即时规则和人机确权审批类物理挪入 `src/core/usecases/` 下，作为内置的拦截切面（Inner Interceptors）。沿用现有的 `HookContext` 上下文承载器，物理收缩领域决策的防御边界。
2. **彻底的依赖反转（DIP）**：移除核心用例（`SessionManager` 与 `AgentLoop`）中对 `adapters/` 层所有具体类（如 `ToolRegistry`、`McpToolManager`）的物理 `import` 引用。在系统物理入口 `src/index.ts` 处统一完成具体适配器的实例化，再通过构造函数以 Port 契约形式注入核心。
3. **安全服务（SecurityService）去耦**：在 Port 中定义安全配置获取接口，外围工具和基础基类均面向 Port 获取授权状态，彻底切断对核心 `SecurityService.getInstance()` 全局单例的直接物理依赖。
4. **接口隔离（ISP）改造**：将 `SessionEventPort` 拆分为超薄的职责单一接口（如 `ApprovalPort`、`NotificationPort` 等），精简普通工具在执行时的依赖边界。

## 业务能力

### 新增业务能力
- `ports-isolation`: 外部工具与核心交互时的端口隔离与依赖反转契约。

### 修改业务能力
- （无：本次重构不涉及业务行为或产品需求的规格变动）

## 影响范围

- **受影响代码**：`src/core/usecases/session.ts`、`src/core/usecases/agent-loop.ts`、`src/adapters/tools/toolRegistry.ts`、`src/ports/driven/SessionEventPort.ts` 以及位于 `src/adapters/plugins` 和各个 system/filesystem 工具中的依赖引入。
- **测试代码影响**：需要同步修改 `test/` 目录下部分受 import 路径或构造参数变动影响的单元测试与集成测试代码。
