# 探索主题: 六边形架构改造与依赖解耦

## 1. 问题定义
目前核心层 Brain 与外围工具 Action 之间存在双向依赖。 核心层 `SessionContext` 直接被工具层引用，导致工具层直接感知了领域实体的细节。 另外， `session.ts` 中直接 `import` 了具体工具如 `BrowserSession` 等，不仅造成了循环耦合，也使得工具层难以进行独立的单元测试。 本次探索旨在通过六边形架构重构两者的依赖流向，实现真正的解耦。

## 2. 关键发现与调研结果
- **物理依赖违规**： **核心直接依赖**： `src/brain/session.ts` 依赖了 Action 层的 `McpToolManager`、 `ToolRegistry` 以及 `BrowserSession`，属于核心层对具体外部工具的违规依赖。

- **类型对象泄露**： **实体直接传递**： 工具的 `execute` 方法签名直接持有了 `SessionContext` 这一核心领域实体，使工具层能够直接访问并修改敏感领域状态。

- **测试环境耦合**： **单测过度依赖**： 单元测试中为了测试单个工具的逻辑，被迫实例化庞大的 `SessionContext` 实体，导致测试难以隔离和维护。

- **业界前沿核实**： **明确驱动流向**： 联网调研表明，在 AI Agent 架构中， LLM 与 Tools 应当统一被视为被驱动的输出适配器（Driven Adapters），核心层通过输出端口（Driven Ports）进行抽象控制，外部调用（如 CLI）则是驱动适配器（Driving Adapters）。

## 3. 方案对比与推荐方向
为了解决工具层 `execute` 方法对领域对象的直接依赖，我们对比了两种潜在的设计方案：

| 评估维度 | 方案 A (引入 SessionEventPort 薄接口) | 方案 B (保留 SessionContext 引用) | 结论 |
| :--- | :--- | :--- | :--- |
| 隔离程度 | 强 ✓：工具层仅对最小接口契约产生依赖 | 弱 ✗：仅做目录重组，类型依赖依旧紧密 | 方案 A 占优 |
| 测试便利 | 高 ✓：单测中可快速 Mock 极简 Port 接口 | 低 ✗：单测必须构建完整的 Session 运行环境 | 方案 A 占优 |
| 改造代价 | 高 ✗：需成批修改全部工具的签名及其单测 | 低 ✓：仅更改物理位置与导入路径 | 方案 B 占优 |
| 维护安全 | 高 ✓：保护领域模型状态免受外部意外篡改 | 低 ✗：外围工具可任意访问和修改实体状态 | 方案 A 占优 |

**推荐路径**：
**执行方案 A**： 我们明确推荐采纳 **方案 A (引入 SessionEventPort 薄接口)**。 既然本项目作为全新项目，没有历史包袱与后向兼容负担，就应当采取最纯粹的解耦设计，一次性解决单测困难与领域模型暴露的问题。

### 目标目录结构规划

为了实现物理与契约的双重隔离，我们规划了如下的目标目录结构：

```text
src/
├── core/                    # 六边形内部（领域核心）
│   ├── domain/              # SessionContext, AgentState, PluginPatchGroup 等实体
│   └── usecases/            # AgentLoop, CompactionService, RuleManager, PluginRegistry 等纯业务逻辑
├── ports/                   # 端口层（抽象契约）
│   ├── driving/             # Input Ports：外部驱动核心的接口（用例入口）
│   │   └── ChatUseCase.ts
│   └── driven/              # Output Ports：核心驱动外部的接口（基础设施抽象）
│       ├── LlmPort.ts
│       ├── ToolExecutorPort.ts
│       ├── SessionEventPort.ts
│       └── TaskAborterPort.ts
├── adapters/                # 六边形外部（具体实现）
│   ├── input/               # Input Adapters（驱动者，如 CLI 入口）
│   │   └── interface/       # CliFacade, InputListener, commands
│   ├── llm/                 # OpenAiLlmAdapter, TiktokenEstimator
│   ├── tools/               # 所有工具（terminal, browser, fs, git, mcp 等）
│   └── plugins/             # 具体插件实现（如安全审核插件、日志审计插件等）
├── config/                  # 不变
└── common/                  # 不变
```

## 4. 约束、风险与未知项
- **重构顺序约束**： **严守四步策略**： 执行重构时必须严格遵循 “1. 原地定义 Port 并用薄接口解耦依赖” -> “2. 原地修改 `session.ts` 解决具体适配器导入” -> “3. 物理迁移目录并重整物理 `import`” -> “4. 运行回归测试验证” 的顺序，严禁直接大范围移动文件，防止系统长期处于无法编译状态。

- **多域签名审计**： **防范运行时缺失**： 系统内目前存在 `terminal`、 `browser`、 `fs` , `git`、 `skill`、 `mcp` 共 ` 6 ` 个子域工具，在接口定义前必须对这 ` 6 ` 个子域工具对 `SessionContext` 的所有实际调用方法进行全量 ` API ` 审计，确保 `SessionEventPort` 中覆盖全部必要方法。

- **插件系统归属**： **采用依赖反转**： 将插件注册中心 `PluginRegistry` 和管道执行 `runHookPipeline` 归为核心用例，留在 `core/usecases/` 中； 具体的插件实现作为适配器，存放在 `adapters/plugins/` 下； 插件间传递的数据结构（如 `LlmRequest`）下沉至 `ports/` 中。 这一结构使外部具体插件单向依赖核心契约，避免了核心向外依赖的问题。

- **接口完整梳理**： **防范漏掉方法**： 必须详尽梳理现有工具对 `SessionContext` 调用的每一个方法（如 `addNotification`、 `emit` 等），确保抽象出的 `SessionEventPort` 覆盖全部真实需求。

- **回归测试波动**： **确保测试全绿**： 重构范围涉及所有工具方法签名，需要保持测试运行环境的稳定，采用渐进式重构避免长时间的编译中断。

## 5. 否决方案
- **保留 SessionContext 引用（方案 B）**： **依赖不彻底**： 仅作目录重排虽能消除循环依赖，但类型硬编码和测试耦合的顽疾并未根治，违背了物理与契约双重隔离的设计初衷。

- **FacadePort 输入端口方案**： **混淆接口概念**： 误将输入适配器 `CliFacade` 定义为 Input Port。 规范的设计应是由 `CliFacade` 来调用定义在 Core 层的 `ChatUseCase` 接口。
