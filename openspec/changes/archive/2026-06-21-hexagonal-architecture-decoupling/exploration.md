# 探索主题: 六边形架构改造后耦合问题评估与 AI Agent 架构适用性思辨

## 1. 问题定义
在最近一次针对六边形架构（Ports and Adapters）的重构中，虽然在物理目录上将代码划分为 `core/`（核心领域用例）、`ports/`（抽象契约接口）和 `adapters/`（外部具体实现），但实际运行和后续迭代中，开发人员反映系统内依然存在多处严重的耦合。本探索旨在深度剖析当前代码库的真实耦合痛点，评估六边形架构在 AI Agent 系统中的适用度，并探讨更适合智能体演进的软件架构模式。

## 2. 关键发现与调研结果

### 代码库现状与真实耦合痛点
经过对 `src/` 下各层代码的深度审查，我们发现以下核心痛点：

1. **“物理隔绝”下的隐式循环依赖与反向物理依赖**：
   - **核心向外依赖**：核心用例 `SessionManager` ([session.ts](file:///d:/Projects/MyAgent/src/core/usecases/session.ts#L2-L21)) 依然通过物理 `import` 硬编码导入了适配器层的 `ToolRegistry`、`McpToolManager` 以及 `TokenWatermarkPlugin` 等具体插件类；而 `AgentLoop` ([agent-loop.ts](file:///d:/Projects/MyAgent/src/core/usecases/agent-loop.ts#L1)) 仅导入了 `ToolRegistry`（未直接导入 `McpToolManager`）。由于没有在系统入口进行依赖注入，而是由核心层亲自 `new` 实例化这些外部适配器，导致六边形架构的核心原则（“核心不依赖外部”）在物理层面破防。
   - **适配器向内依赖**：外部适配器（如具体的 Tools 与 Plugins）大量反向依赖了核心用例层的具体实现类。例如：
     - `terminal.ts` ([terminal.ts](file:///d:/Projects/MyAgent/src/adapters/tools/tools/system/terminal.ts#L10)) 直接调用了核心层的 `SecurityService.getInstance()`。
     - `TokenWatermarkPlugin` ([TokenWatermarkPlugin.ts](file:///d:/Projects/MyAgent/src/adapters/plugins/TokenWatermarkPlugin.ts#L5)) 直接引用并保存了核心用例 `CompactionService`。
     - `JitRulesPlugin` ([JitRulesPlugin.ts](file:///d:/Projects/MyAgent/src/adapters/plugins/JitRulesPlugin.ts#L3)) 直接引用并调用了核心层的 `ToolDispatcher`。
   - 这导致了严重的**环状依赖（Circular Dependency）**：`SessionManager` -> 实例化 `TokenWatermarkPlugin` -> 依赖并调用 `CompactionService` -> 被 `SessionManager` 所持有。这种复杂的网状依赖甚至比重构前更加隐蔽，极难进行真正的测试隔离。

2. **接口隔离原则（ISP）失效**：
   - `SessionEventPort` ([SessionEventPort.ts](file:///d:/Projects/MyAgent/src/ports/driven/SessionEventPort.ts)) 共定义了 6 个方法，包含了获取会话/租户 ID、发送异步通知、挂起审批流程（`waitApproval`）以及工作模式查询。虽然方法数量不多，但它强行把安全审批、状态查询和事件通知混在一个契约中，使得外围的普通系统工具（如 `filesystem`）被迫持有无关的敏感接口，增加了模块间的隐式行为耦合。

3. **核心防御策略被“外包”为外围插件，导致边界错置**：
   - Agent 的内置防御机制（如 Token 水位控制、即时伴生规则注入）本质上属于**核心领域服务（Domain Services）**，是智能体推理循环不可分割的一部分。然而在重构中，它们为了套用“外部插件”的定义被挪到了 `adapters/plugins/` 下。为了实现压缩和规则拼装，这些外挂插件又不得不依赖核心的 `CompactionService` 和 `ToolDispatcher`，导致了概念上的域外漂移与跨层耦合。

### 行业调研与学术/工程界洞察
通过对 AI Agent 架构最佳实践进行联网核实，我们得出以下结论：
- **组合架构是行业的主流趋势**：在构建高质量的 Agent 时，业界倾向于采用**组合方案（Hexagonal Core + Inner Pipeline Interceptors）**。六边形架构的核心价值在于**隔离不确定、高波动的外部 I/O 边界**（如 LLM API 调用、MCP 服务、物理系统工具），确保核心主循环不受物理环境干扰；而核心内部则通过**管道与拦截器模式**，对大循环内部的各个推理阶段（SessionStart, BeforeModel, AfterTool）实施规则、安全和容量的动态横切（AOP/Interceptor）。这两者绝非互斥关系，而是应该内外互补。

---

## 3. 方案对比与推荐方向

在明确当前的耦合痛点后，我们需要研判这究竟是六边形架构范式本身在 Agent 系统中存在局限，还是因为缺乏内部扩展规范与实施质量偏低所致。为此，我们对以下两种改进路线进行对比评估：

| 评估维度 | 方案 A：规范化六边形架构（完善依赖反转与接口隔离） | 方案 B：组合方案（六边形外部防线 + 核心内部拦截管道） | 选型分析 |
| :--- | :--- | :--- | :--- |
| **外部 I/O 隔离性** | 极强 ✓：彻底隔离外部 LLM、终端与物理文件系统。 | 极强 ✓：核心物理边界依然保留 Port/Adapter 屏障。 | 势均力敌 |
| **记忆与状态内聚性** | 强 ✓：策略可通过规范化设计收紧在 Core 内部（项目内已具备 pipeline-runner 管道）。 | 强 ✓：将水位控制、JIT 规则置为核心拦截器，作为主循环管道切面，不暴露给外部，逻辑高度内聚。 | 势均力敌 |
| **开发迭代效率** | 高 ✓：在稳定 Port 契约后，修改仅发生于 Core 或 Adapter 单侧。 | 极高 ✓：内部策略物理收纳在 Core 内，改动直观，无需跨多层目录同步。 | **方案 B 占优** |
| **测试隔离度与单测成本** | 高 ✓：外部 Port 极易 mock，保证核心循环的高效单测。 | 高 ✓：外部 Port 易于 mock，且核心内部拦截管道可通过 mock 运行上下文进行独立切面测试。 | 势均力敌 |
| **物理依赖清洁度** | 强 ✓：通过构造注入（轻量 DI）彻底消除 `import` 适配器的物理依赖。 | 强 ✓：同样通过构造注入解耦外部适配器，核心依赖保持纯净。 | 势均力敌 |

### 推荐路径
我们倾向于推荐 **方案 B（组合方案：六边形外部防线 + 核心内部拦截管道）**。
两者的物理差异与改造跨度其实非常轻量：由于 `plugin-types.ts` 等管道机制已经作为核心用例驻留在 `core/usecases/` 下，因此组合方案并非颠覆性的架构范式升级，其本质是**将本属于核心领域决策的两个拦截器（水位控制与即时规则）物理移回 Core 内部，并解除跨层级的物理硬引用耦合**。
该方案既保留了六边形架构对外部 I/O 资源（大模型、外部工具、文件系统）的坚固物理防御和极佳的测试隔离性，又通过将 Token 水位压缩、即时规则组装物理回归为核心的拦截切面，解决了职责错置和环状依赖的顽疾。

**具体行动路线**：
1. **拦截器物理移回与去强耦合**：将 `TokenWatermarkPlugin`（水位压缩）与 `JitRulesPlugin`（JIT 伴生规则）从外围适配器 `adapters/plugins` 回收至 `core/usecases/` 下。沿用现有的 `HookContext` 上下文承载器，无需引入新概念的拦截器上下文抽象。重设 `import` 路径即可，改动极为轻量。
2. **彻底实施依赖反转（DIP）**：
   - 核心层绝对禁止物理 `import` 或实例化任何 `adapters/` 下的具体适配器类。
   - 定义 `ToolRegistryPort`、`ContextRepositoryPort` 等输出端口契约，具体的 `ToolRegistry` 实例化放在系统入口（如 `CliFacade` 或 `index.ts`），在构造时通过接口形式注入核心 `SessionManager` 和 `AgentLoop`。
3. **遵循接口隔离原则（ISP）拆分 Port**：
   - 将臃肿的 `SessionEventPort` 拆分为职责单一的超薄 Port 接口（例如：负责用户确权的 `ApprovalPort`、负责状态通知的 `EventNotificationPort`），防止外部工具对核心领域产生非必要的宽泛依赖。

---

## 4. 约束、风险与未知项
- **测试用例覆盖核实**：经探索阶段运行测试脚本 `npm run test` 实际验证，项目当前共运行了 **20** 个测试套件，包含 **98** 个测试用例，且 100% 成功通过。由于重构调整了拦截器位置、引用的导入路径以及接口签名，需要对这 98 个单元与集成测试用例做相应重构适配，必须确保重构过程中测试能够随时跑通。
- **循环引用规避**：在定义核心拦截管道时，须严密防范 `AgentLoop` 与核心拦截器之间可能引入的二次循环引用。

---

## 5. 否决方案
- **放弃六边形，倒退为无分层混杂结构**：彻底摒弃六边形架构会让大模型 API 和高度危险的物理终端等外部资源直接与核心大循环硬纠缠，导致无法编写单元测试，彻底丧失隔离安全性，不可采纳。
- **维持现状“物理六边形，实质强耦合”**：不加改正的伪六边形架构不仅失去了架构隔离的初衷，还平白增加了目录嵌套层级与多层转发代码，不可接受。
