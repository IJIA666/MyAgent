# 探索主题: 常量与通用工具的目录解耦和高内聚重构

## 1. 问题定义
目前，`MyAgent` 系统的内置工具名称和别名静态常量全部存放在 `src/common/constants.ts` 中，而部分的辅助方法（如文本处理、只读校验）和通用函数层级定位模糊。这带来了以下痛点：
1. **修改体验割裂**：新增或修改一个原生工具，需要同时修改不相邻的两个根目录文件（`src/common/constants.ts` 和 `src/action/native-tools/*`）。
2. **大杂烩与循环依赖风险**：`common` 和 `utils` 容易退化为“垃圾抽屉（Junk Drawer）”反模式，随着系统规模扩大，高低层模块同时依赖它们极易引入循环依赖。
3. **文件目录感官杂乱**：缺乏模块内部的局部辅助工具闭环，混淆了“无状态基础工具”与“带工具业务属性的辅助函数”。

## 2. 关键发现与调研结果
- **代码库现状**：
  - `src/common/constants.ts` 集中声明了全部原生工具和终端别名列表（`FILE_READ_ALIASES` 与 `FILE_WRITE_ALIASES`）。这些常量除工具自声明外，主要被 `src/brain/plugins/HumanApprovalPlugin.ts` 用于前置拦截判断。
  - 项目根目录的 `src/utils/` 主要负责 ANSI 清洗、日志脱敏等纯粹的全局无状态文本操作。
  - 本次扩展中引入的递归复制、大纲提取及补丁滑动窗口对齐，其实都强烈依附于 `action`（工具执行层）内部，而非全局通用逻辑。
- **核实与洞察**：
  - 行业对于 TypeScript 模块化工程的共识是避免过度使用全局的 `common` 或 `utils`，而提倡**特性优先（Feature-First）组织模式**。
  - 如果一个辅助函数没有被三个以上的独立领域模块共用，则应当将其**就近共存（Co-locate）**在特性或组件内部，以达成局部的高内聚。
  - **Claude Code 源码结构调研发现**：
    - 核心目录设计为 `src/tools/`，且每个内置工具独立建文件夹（如 `src/tools/FileReadTool/`）存放。
    - 每个工具目录包含该工具的完整逻辑自闭环，如 `FileReadTool.ts`（工具实现）、`limits.ts`（大小限制）、`prompt.ts`（提示词）。
    - **极其关键的常量设计**：虽然存在全局常量声明文件 `src/constants/tools.ts`，但它不直接硬编码工具名称字符串，而是使用 `import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/prompt.js'` 方式将各工具的私有常量导入，仅在全局做特征合集归并（如 `ASYNC_AGENT_ALLOWED_TOOLS`）。这证明了“源头契约在工具内部声明，全局只做合集归约”的高内聚做法在成熟项目中的实际应用。
  - **Claude Code 整体目录架构设计剖析**：
    - `src/cli/`：处理 REPL 启动、退出逻辑以及控制台 structured/remote I/O 的输入输出捕获抽象。
    - `src/services/`：提供高层核心基础服务，例如 `compact/`（上下文自适应压缩）、`mcp/`（外部 MCP 通信）、`tokenEstimation.ts`（Token 精密用量计算）、`lsp/`（与语言服务交互进行 AST 源码审计）。
    - `src/plugins/`：内置和外置插件管理器，支持通过插件注入自定义的 `skills`、`hooks` 和 `mcpServers`，并在运行时进行启用/禁用状态的热管理。
    - `src/components/` 与 `src/screens/`：基于 React Ink 打造终端 GUI 组件与跨屏看板，替代传统的命令行裸字符串回显，提升人机审批和交互呈现效果。
  - **OpenCode 源码结构调研发现**：
    - **Monorepo 多包物理拆分**：采用基于 Turborepo/Bun 的 monorepo 架构，将 `packages/core`（核心智能体引擎）、`packages/cli`（脚手架终端）、`packages/tui`（交互式 TUI）、`packages/llm`（模型层）、`packages/plugin`（插件库）进行彻底物理隔离，规避了大型项目的模块交叉干扰。
    - **函数式 `make` 声明与 Effect 契约**：在 `packages/core/src/tool/tool.ts` 中使用函数式 `make` 工厂代替传统的 Class 派生工具。工具输入输出完全由 `effect/Schema` 动态强类型定义，并自动转换为大模型所需的 JSON Schema。
    - **装饰器权限切面（AOP）机制**：提供了 `withPermission` 装饰器，能在底座注册工具时，将安全审计（如 `filesystem:write` 权限）作为切面动态包裹在工具外层。该设计避免了工具内部侵入式编写确权代码，真正做到了安全审计与工具执行的高内聚解耦。

  - **Hermes 源码结构与工具链设计剖析**：
    - **解耦常量依赖**：**无依赖常量声明**。 `hermes_constants.py` 坚持无第三方和项目内依赖设计，完美避开循环依赖。通过 `ContextVar` 机制支持线程和协程级别的环境隔离，为高并发多 `Agent` 任务提供基础支撑。

    - **单例自注册表**：**去中心化工具注册**。使用 `tools/registry.py` 统一管理工具的元数据与生命周期。各工具模块在被加载时向 `registry` 进行自注册，通过 `ast` 静态分析机制，避免全量预导入带来的启动损耗和依赖纠缠。

    - **耗时检测缓存**：**探测结果缓存优化**。针对检测工具环境可用性（如 `Playwright` 、 `Docker` 状态）的 `check_fn` ，引入了全局 30 秒 `TTL` 缓存。降低每次大模型交互轮询调用时产生的环境探测开销，平衡了环境感知与运行性能。

    - **模型输出容错**：**参数纠偏与输入净化**。在 `model_tools.py` 中，提供大模型参数类型自动强转、标量包裹为数组的容错机制。针对异常信息，内置剥离敏感标签与格式化控制字符的净化逻辑，防止大模型发生提示注入或角色混淆。

    - **高危行为防御**：**双层审批与安全拦截**。在 `tools/approval.py` 中，对所有执行指令进行 `ANSI` 剥离、转义词清洗与 `Unicode` 标准化。提供 `HARDLINE_PATTERNS` （无条件硬阻断）与 `DANGEROUS_PATTERNS` （可 `YOLO` 绕过或网关异步审批）的双层安全防御。

    - **场景渐进暴露**：**多场景组合与渐进展示**。通过 `toolsets.py` 进行工具集合的嵌套组合，按需进行平台适配（如只读 `webhook` 包、编辑器 `acp` 包）。在工具库庞大时激活 `tool_search` 渐进式检索，以降低 `API` 上下文消耗。

  - **OpenClaw 源码结构与工具链设计剖析**：
    - **全闭环插件架构**：**插件化扩展机制**。 `OpenClaw` 采用统一的 `plugin-sdk` 规范，具体工具与服务被彻底剥离到 `extensions/` 的 130 多个子目录中。插件不仅提供 `LLM` 工具，还能以契约形式向系统注入 `CLI` 脚手架、 `RPC` 网关方法、微服务及安全审计收集器。

    - **延迟动态导入流**：**降低启动与内存**。插件通过在 `plugin-registration.ts` 中声明常驻内存的 `schema` 和元数据，而将重度执行逻辑和依赖动态包裹于 `register.runtime.js` 中。直到工具被实际调用时才触发 `import` ，实现极速的轻量化启动。

    - **声明式约束引擎**：**结构化可用探测**。在 `src/tools/availability.ts` 中实现可用性探测。工具通过描述符 `availability` 声明其对 `"auth"` 、 `"config"` 、 `"env"` 或 `"plugin-enabled"` 的强依赖，并支持代数式的 `"allOf"` 与 `"anyOf"` 逻辑嵌套。

    - **网关级阻断机制**：**控制面权限拦截**。在 `src/security/dangerous-tools.ts` 中，独立声明 `DEFAULT_GATEWAY_HTTP_TOOL_DENY` （网关 HTTP RPC 默认禁止的工具列表，如 `exec` 、 `fs_write` ），专门针对非交互式接口防止大模型提权，从而将权限安全拦截独立成审计层。

  - **Gemini-CLI 源码结构与工具链设计剖析**：
    - **契约就近定义**：在 `packages/core/src/tools/tool-names.ts` 中，所有核心工具（如 `glob` 、 `grep` ）和参数名称（如 `PARAM_FILE_PATH` ）皆由 `./definitions/coreTools.js` 导入后再重新汇聚导出，避免全局 constants 垃圾抽屉反模式。

    - **兼容历史别名**：在 `TOOL_LEGACY_ALIASES` 注册工具历史别名，并在 `getToolAliases` 方法中提供向上归约能力。保证用户已有的安全策略在工具更名升级后仍被完整继承，免遭拦截绕过风险。

    - **参数限制过滤**：通过 `TOOLS_REQUIRING_NARROWING` 常量显式限制高危操作的参数范围。在 `policy-engine.ts` 中基于规则优先级（ priority ）提供动态规则热拔插，且对 `shell` 工具进行子命令递归分拆启发式检查，检测重定向并强制降级至 `ASK_USER` 确权。

  - **Codex 源码结构与工具链设计剖析**：
    - **声明式拦截规则**：在 `codex-rs/execpolicy` 中使用 `Starlark` 语法来编写拦截策略 `prefix_rule` 。定义精确分词序列，并支持 `allow` 、 `prompt` 、 `forbidden` （硬阻断，防 YOLO 模式绕过）三种执行等级。

    - **规则内置自测**：规则定义中强制包含 `match` 与 `not_match` 测试样例。在拦截引擎启动加载（编译）时自动验证规则正则的准确性，防止人工编写规则时漏配或错配漏洞，从而把拦截失误遏制在编译期。

    - **绝对路径锚定**：提供 `host_executable(name, paths)` 锁定本地二进制文件的物理绝对路径（如 `/usr/bin/git` ）。防止恶意代码修改环境变量 `$PATH` 或利用软链接伪造安全命令，从底层防御沙箱逃逸。

  - **Tinypace-AI-Desktop 源码结构与工具链设计剖析**：
    - **全插件底座**：桌面主进程采用极简设计，不内置任何具象工具逻辑。通过 `MCPServerManager` 根据打包路径（ `getMcpPath()` ）动态扫描并拉起外部进程，将所有功能收拢为统一的 `MCP` 协议请求。

    - **强生命期管控**：在 `destroyServer` 中提供了健壮的停止、 PID 擦除以及端口强制释放逻辑（ `taskkill` 与 `lsof` ）。彻底规避桌面应用挂起退出后产生僵尸进程或端口死锁的缺陷。

    - **网关确权隔离**：因为所有执行均走统一的 `MCP` 的 JSON-RPC 请求，拦截逻辑高内聚在 `TaskExecutionManager` 接口调用层。向子进程发送请求前拦截并弹出原生窗口要求用户确权，保护桌面系统安全。

## 3. 方案对比与推荐方向

| 评估维度 | 方案 A (保持现状: 跨模块共享 common 契约) | 方案 B (高内聚: 常量下沉与局部 utils 闭环) | 方案 C (去耦合化: 动态元数据与运行时别名判定) | 结论 |
| :--- | :--- | :--- | :--- | :--- |
| **依赖耦合度** | 中（多层模块共同静态依赖 `common`） | 低（常量只存在于 action 层，插件层依赖 action 提供的类型） | 极低（完全免除静态常量，运行时动态推断与匹配） | 方案 C 最佳 |
| **维护便捷性** | 低（增加新工具需要跨不相关目录修改） | 中（可在一个 action 文件夹下完成常量与实现） | 极高（仅需在 Tool 类内声明 metadata，大脑自动感应） | 方案 C 最佳 |
| **重构开销** | 零（无需做任何变动） | 中（涉及 plugins 对常量的引用重定向） | 高（需要对 plugins、virtual-mcp 做元数据感知改造） | 方案 A 最佳 |

**推荐路径**：
- **短期行动（已在本次变更落地）**：采用**方案 B 的变体**。我们坚决不把“递归复制、滑动窗口块替换、大纲提取”这类高内聚动作写在全局 `src/utils/`，而是直接内聚在各自对应的工具文件内部做闭环。
- **长期行动（推荐演进）**：采用**方案 C（运行时元数据派发）**。后续可在 `NativeTool` 契约中扩展 `readOnly: boolean` 或 `aliases: string[]` 的元数据属性。大脑的 `HumanApprovalPlugin` 插件直接在运行时读取加载后的工具实例元数据来判定是否属于只读/写入工具，从而彻底拔除并废弃 `src/common/constants.ts` 这一全局静态契约。

### MyAgent 借鉴落地设计详情

- **自声明核心设计**：采纳以 “自声明” 为核心的去耦合机制，将工具安全特征决定权归于工具自身，消除全局静态拦截名单。

- **删除全局名单**：删除 `src/common/constants.ts` 中用于前置安全拦截的 `_ALIASES` 系列硬编码静态常量，彻底斩断对多工具列表的同步维护成本。

- **工具自报家门**：在 `NativeTool` 接口中添加 `securityCategory` 属性。原生工具或第三方 `MCP` 插件内部自声明 `readonly securityCategory = 'write' | 'read'` 属性，自主界定安全分类。

- **网关动态拦截**：在 `HumanApprovalPlugin` 插件拦截时不再比对静态常量名单，改为运行时直接读取目标工具的 `securityCategory` 属性。若判定为 `'write'` 则自动前置发起弹窗审批确权，拔除 `brain` 与 `action` 的静态依赖。

- **局部就近闭环**：工具私有的辅助计算逻辑（如 `Unified Diff` 应用、大纲分析、文件复制）禁止写入全局 `src/utils/` 。必须就近以内聚函数或辅助类形式闭环在工具同级文件夹中，保持全局 `utils` 无状态属性的纯粹。

- **按需特征汇集**：若其他上层模块或类型系统确实需要在编译期拥有所有工具的特征全集，借鉴 `Claude Code` 做法。在 `src/common/constants.ts` 中不直接硬编码，而是通过 `import` 导入各工具的私有名称并汇聚为只读 `Set` 导出。

## 4. 约束、风险与未知项
- **循环依赖风险**：如果简单将常量下沉到 `action`，而在 `HumanApprovalPlugin` （属于 `brain` 层）直接 import `action` 下的工具，将引入 `brain -> action -> brain` 的大循环依赖，导致构建挂死。未来必须将插件解耦，或者通过元数据接口在 virtual-mcp 服务初始化时注册到上下文。
- **动态 Schema 稳定性**：如果方案 C 动态推断 Schema，需保证输出格式对大模型强稳定，否则大模型的 system prompt 指纹会频繁刷新导致 API 缓存（Prompt Cache）击穿。

## 5. 否决方案
- **把所有的工具辅助方法（如 Unified Diff 应用、大纲提取、递归复制）全部放置在全局 `src/utils/` 下**。否决原因：这会严重污染项目全局工具库，打破 Feature-First 的高内聚原则，使得这些与业务强相关的辅助逻辑在外部无法被复用。
