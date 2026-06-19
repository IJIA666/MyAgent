# 探索主题: 六边形架构与工具包内聚重构

## 1. 问题定义
目前智能体的内置工具代码均作为扁平文件平铺在 `src/action/native-tools/` 目录下（共 18 个文件），且全局工具名契约散落。这带来了明显的“水平切分”弊端：
1. **领域知识物理散落**：具体的工具实现与相关的专属辅助逻辑（如 `apply-patch-helper.ts` 等 `helper`）被平铺在同一层级，没有按业务 Feature 进行物理聚合与内聚。
2. **跨层双向紧耦合**：脑皮层的插件 `HumanApprovalPlugin` 静态导入了 `action` 层的特定工具辅助逻辑（如 `terminal-config.ts`、`terminal-guard.ts`）来进行危险命令检测。这导致 Core 与具体的 Adapter 工具细节在编译期强耦合，违背了六边形架构中 Domain Core 不依赖外围 Adapter 实现的原则。

本探索的目标在于：探讨将 Action 层原生工具按业务 Feature 子目录打包内聚，并解决脑网关插件与具体工具在安全审查层面的强耦合，建立更加纯粹的六边形架构。

---

## 2. 关键发现与调研结果
- **代码库现状**：
  - 脑部核心 `src/brain/agent-loop.ts` 已经实现了较好的依赖注入。它并不直接依赖具体的工具类，而是通过 `ToolRegistry` 来管理工具。
  - 然而安全网关插件 `HumanApprovalPlugin` 中存在对终端命令的具体判定规则（如正则匹配 `DESTRUCTIVE_REGEX`），并静态导入了终端的配置与防护函数。
- **核实与洞察**：
  - **跨项目调研**：通过剖析 `Agents/claude-code` 的源码可以发现，其内部的 `BashTool`、`FileReadTool` 等每一个复杂工具都拥有**独立的子目录**。在 `BashTool` 的目录中，内聚了它专属的安全防护（`bashPermissions.ts`、`bashSecurity.ts`、`pathValidation.ts`）和界面交互（`UI.tsx`）。这种 Feature 级物理内聚的设计模式使得工具内部的知识能够高度闭环，避免了散落。
  - **六边形架构（Hexagonal Architecture）最佳实践**：联网核实表明，Agent 的 Core（推理循环、决策网关）作为 Domain Core，应当只通过抽象的 Ports（如 `NativeTool` 契约接口）来调度具体工具的 Adapter。安全网关拦截也应当基于 Ports 定义的通用属性或契约，而不是依靠直接 import 具体的工具和特化的 helper 来完成。

---

## 3. 方案对比与推荐方向

为了实现“六边形架构 + 工具包内聚”，我们规划了以下三种重构方案：

| 评估维度 | 方案 A：工具包物理内聚 + 编译层半解耦 | 方案 B：契约化安全审查 + 运行时彻底解耦（推荐） | 方案 C：外包中介 Verifier 间接解耦 |
| :--- | :--- | :--- | :--- |
| **重构设计** | 将 `native-tools` 下的所有扁平文件按 Feature 归入 `git`、`filesystem`、`system`、`skill` 子目录。在各子目录建立 `index.ts` 集中向 `virtual-mcp.ts` 提供批量注册，消除全局工具名类。脑部插件仍物理 import 各子目录的安全判定 helper。 | 同样进行 Feature 子目录物理聚合。但在 `NativeTool` 契约接口中引入安全审查机制（如 `checkSafety(args)` 接口）。由各个具体工具自身实现该方法（例如终端工具内部实现命令级别初筛，文件工具内部进行路径沙箱越界检测）。脑网关插件仅通过该通用 Ports 契约对任何工具进行无状态审查和人机挂起，彻底断开对具体工具类的直接依赖。 | 将安全判定从脑部插件和工具中剥离，在 `action` 层提供一个集中式中介 `ActionSafetyVerifier`。网关插件只调用该中介类，由中介类负责引入并执行各个工具的特化安全判定。 |
| **大脑（Core）纯粹度** | 较弱 ✗（网关仍需感知并导入终端和文件的安全校验细节） | 极强 ✓（大脑与具体 Adapter 的安全判定逻辑编译期完全解耦，仅依赖 Port 契约） | 强 ✓（大脑仅需依赖中介 verifier 即可） |
| **各 Feature 内聚度** | 强 ✓ | 极强 ✓（安全逻辑与工具行为在 Feature 包内彻底闭环） | 较强 ✓（但安全规则会部分移入中介类） |
| **可测试性** | 中 | 极高 ✓（安全审查可脱离整个运行网关进行独立的单元测试） | 强 |
| **实施复杂度** | 低 | 中（需轻微调整 `NativeTool` 契约，并在各原生工具实现类中补齐安全审查钩子） | 中 |

**推荐路径**：选择 **方案 B**。
- **理由**：方案 B 是最纯正的六边形架构演进。它通过在 Ports 接口（`NativeTool`）中建立统一的安全审查规范，将具体工具的“特化领域知识”（如什么样的 Shell 命令是危险的、文件写路径如何校验等）彻底封锁在 Adapters（具体 Feature 工具包）内部。这不仅在编译期和逻辑上断开了 Core 与 Adapter 的双重耦合，而且为未来引入外部 MCP 工具的安全防护判定打下了一致性基础。

---

## 4. 约束、风险与未知项
- **接口兼容性风险**：在 `NativeTool` 接口中添加 `checkSafety` 方法后，需要保证在 `LocalFileSystemMcpServer` 注册或测试中没有破坏原有的依赖关系。
- **契约返回值的结构设计**：为满足网关插件生成友好人机交互提示（`message`）与授权前缀（`safePrefix`）的诉求，`checkSafety` 绝不能返回简单的 `boolean`。需要定义标准化的 `SafetyCheckResult` 对象：
  ```typescript
  export interface SafetyCheckResult {
    status: 'pass' | 'suspend' | 'deny';
    message?: string;      // 用于人机审批时向用户展示的警告提示信息
    safePrefix?: string;   // 终端工具特有，用于安全白名单持久化的匹配前缀
    targetPath?: string;   // 文件工具特有，越界读写的物理目标路径
  }
  ```
- **纯函数校验与副作用分离**：`checkSafety` 方法必须设计为无状态、无副作用的纯函数（Pure Function），仅负责安全评估（“只查不写”），绝对不直接在方法内修改白名单。临时白名单的写入动作必须在用户审批通过后，由网关插件或全局安全服务统一执行，确保安全状态的一致性与可测试性。
- **异步支持要求**：由于文件路径的沙箱越界检测等往往需要配合文件系统物理实名还原（如调用 `fs.realpath` 等涉及外部 I/O 的操作），`checkSafety` 必须定义为异步方法，返回 `Promise<SafetyCheckResult>`。

---

## 5. 否决方案
- **全局集中化安全判定器**：曾考虑将所有命令安全分析和路径防护集中写到全局 `src/common/security/` 中。该方案已被否决，因为它违背了“工具包内聚”的核心思想，使得每次新增一个工具时，都必须去全局安全模块中补充其对应的安全拦截策略，导致特定领域的知识继续散落。
