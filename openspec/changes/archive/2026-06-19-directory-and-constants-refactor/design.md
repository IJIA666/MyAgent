## 背景

目前，MyAgent 系统的原生工具契约常量和拦截别名（如 `ToolConstants.TERMINAL_ALIASES`、`ToolConstants.FILE_WRITE_ALIASES` 等）集中存放在 `src/common/constants.ts` 中，并被 `HumanApprovalPlugin` 插件直接静态导入引用，用于前置安全审查和授权弹窗。
这种设计面临两个核心痛点：
1. **修改割裂**：新增或修改工具别名时，必须同时修改具体的工具类和全局的常量文件。
2. **循环依赖**：上层的审批流插件静态强依赖下层工具的常量名称集，造成模块耦合。

## 目标与非目标

**目标:**
- 实现工具安全特性的“自声明”机制，让工具在内部自我管理安全分类属性。
- 彻底废弃并删除 `src/common/constants.ts` 中的硬编码 `_ALIASES` 拦截别名名单。
- 改造 `HumanApprovalPlugin`，使其在拦截点动态获取当前被调工具实例的 `securityCategory`，据此判定是否需要挂起等待用户确权。
- 重构工具特有辅助计算逻辑（如 Unified Diff 补丁对齐、大纲分析等），移回各自工具目录就近高内聚闭环。

**非目标:**
- 改变智能体工具调用的入参、核心逻辑及功能规范。
- 改变安全审批的原生 UI 与底座阻塞交互控制。

## 架构决策

### 决策一：工具自声明安全类别（Self-Declaration）
- **方案**：在 `NativeTool` 接口（声明在 `src/action/native-tools/base.ts`）中增加 `securityCategory` 属性，用来标示该工具是安全的只读操作（`'read'`），还是高危的写入/命令行执行操作（`'write'`）。
- **字段类型**：`readonly securityCategory: 'read' | 'write'`。
- **原因**：将分类权赋予工具内部，添加新工具时只需声明该属性即可自动接入拦截系统，无痛适配插件化和第三方 MCP 发现。

### 决策二：网关动态确权拦截（Dynamic Interception）
- **方案**：重构 `HumanApprovalPlugin.ts`，彻底移除对 `ToolConstants` 别名数组的静态引用。
- **机制**：
  1. **依赖注入与上下文获取**：插件在 `BeforeTool` 生命周期拦截时，严禁使用单例模式或跨目录静态 `import` 导入位于 `action` 层的 `ToolRegistry` （防范引入 `brain -> action -> brain` 的编译期静态循环依赖）。正确做法是：在核心引擎层 `src/brain/agent-loop.ts` 实例化 `HookContext` 时，将底座中的 `toolRegistry` 引用作为上下文挂载到 `HookContext` 或其 `sessionContext` 中向下传递。插件从传入的 `context` 中动态获取工具注册表实例。
  2. 获取工具实例后，直接读取其暴露的 `securityCategory` 属性。
  3. 若 `securityCategory === 'write'`，则触发挂起机制，分发 `suspend` 信号阻塞等待用户审批；若为 `'read'`，则直接执行沙箱路径安全性校验。如果是只读且越界，则申请只读授权；否则自动放行。
- **原因**：将拦截判定逻辑与工具名单物理隔离，完全消除 brain 插件层与具体工具层在编译期的静态循环引用。

### 决策三：工具辅助函数的高内聚下沉
- **方案**：将现存的大纲分析算法、 Unified Diff 补丁滑动窗口对齐、文件夹递归复制等算法从全局 `src/utils/` 下沉到各自原生工具同级文件夹下（如 `src/action/native-tools/` 子目录）。
- **原因**：遵循 Feature-First 组织原则，保持全局 `src/utils/` 仅含无状态基础文本/IO函数，避免其退化为垃圾抽屉。

## 风险与权衡

- **[工具未找到风险]** -> 若大模型调用了一个未知名称的外部工具且在注册表中没有对应的实例对象，导致无法读取 `securityCategory`。
  * **缓解策略**：在拦截层提供兜底安全判定。对于在 `ToolRegistry` 中无法解析的未知工具（如大模型幻觉工具或未就绪的 MCP 工具），网关拦截器将其默认归类为 `'write'` 分类，强行降级为 `ASK_USER` 弹窗审批，保证“默认失败关闭”的最高安全底线。

## [调试修正] 领域常量闭环与专属辅助提取设计

在 apply 阶段调试中，发现原方案将 Action 层的内置工具命名常量遗留在全局 `src/common/constants.ts` 中，导致了跨模块的编译期物理泄露。此外，内置工具主类中仍包含复杂的滑动对齐、大纲正则提取等重度算法，文件职责不够单一。

为了彻底消除设计遗漏，进行如下追加调整：
1. **领域常量驱动**: 在 Action 层新建 `src/action/constants/native-tool-names.ts` 文件，将所有的内置工具名常量从全局 `src/common/constants.ts` 迁入其中。全局常量文件仅保留非 Action 层的其它通用配置，不再保留内置工具名常量，以此保证 Action 模块命名完全自闭环。
2. **专属算法物理下沉**: 分别在各原生工具同级提取出 `apply-patch-helper.ts`（用于 Diff 对齐）、`read-many-files-helper.ts`（用于大纲正则和摘要降级）和 `directory-manager-helper.ts`（用于递归文件系统复制），主类文件实现瘦身，仅负责大模型元数据注册与外层 ReAct 调度逻辑。
