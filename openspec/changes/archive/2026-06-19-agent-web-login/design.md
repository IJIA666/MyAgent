## 背景

当前智能体（IJIA Agent）在 [toolRegistry.ts](file:///d:/Projects/MyAgent/src/action/toolRegistry.ts) 中提供了文件级别的沙箱工具与外挂 MCP 工具的加载。为了支持网页信息检索与特定网站的登录自动化操作，我们需要在智能体内部提供一套高内聚、高交互能力的浏览器自动化 Action。

面临的核心技术现状为：网络环境反爬检测加强、人机图形滑块与扫码防范严格、以及首次下载浏览器引擎的体积负担较重。因此需要进行架构层面的精细设计。

## 目标与非目标

**目标:**
1. **集成 Playwright 浏览器底层**：引入 `@playwright/test` / `playwright` 驱动引擎，通过 Native Tool 挂载，实现包括导航、输入、点击、滚动、截图等一系列完备的页面操作指令。
2. **免密会话持久化（Persistent Context）**：支持使用独立本地物理目录（`.myagent/browser-session/`）作为 Session 存储，自动持久化 Cookie、LocalStorage 等。
3. **CDP (Chrome DevTools Protocol) 遥测直连通道**：提供 `chromium.connectOverCDP` 接口，支持智能体直连用户在本地拉起的物理隔离的 Chrome 调试端口（如 9222），实现零门槛直接复用登录态。
4. **命令行人机协同风控阻塞机制**：在智能体推理循环中，如发现需要登录或面临图形滑块校验，支持挂起智能体推理并唤醒有头浏览器窗口，提示并等待用户手动完成验证，用户在命令行中回车后，智能体同步浏览器状态继续任务。
5. **轻量级 DOM 快照与元素标号映射**：开发一个轻量级网页 DOM 快照解析器，提取出可交互的 DOM 节点并分配 `@e1`、`@e2` 等编号，以高度压缩的文本 DOM 树格式返回给模型，极大程度降低 Token 开销。

**非目标:**
1. **防范范围蔓延：不研发全自动图像/图形滑块风控破解功能**（不引入重度图像识别/OCR库，以“有头模式人机协作”为核心兜底）。
2. **不允许直连用户的主力 Chrome 浏览器实例**，避免因智能体网页操作干扰用户工作，或导致潜在的隐私敏感信息泄露。直连模式下，强制/强烈引导用户必须以单独的隔离参数命令启动全新的 Chrome 调试窗口。

## 架构决策

### 决策 1：选择本地内置 Playwright Native Action 替代外部 MCP 服务
- **决策理由**：内置 Native Action 属于智能体直接调用的核心类（挂载于 [native-tools](file:///d:/Projects/MyAgent/src/action/native-tools)），相较于外部 MCP 服务在命令行交互中能完美地执行“同步状态”与“命令行 IO 阻塞等待回调”，能更顺畅地承载“检测到风控挂起 -> 提示用户完成 -> 回车继续”的异步阻塞机制。
- **替代方案**：接入外部社区的 `@modelcontextprotocol/server-puppeteer`。舍弃原因：外部服务以无头模式运行，极难支持有头窗口人机风控协作，且多了一层复杂的 MCP RPC 转发，配置繁杂。

### 决策 2：系统常规浏览器环境探测（executablePath 策略）
- **决策理由**：Playwright 默认会在安装时拉取特定版本的 Chromium 内核（约数百兆），这极大伤害了轻量级 CLI 工具的安装使用体验。我们在构建 Playwright 实例时，先尝试探测系统默认的 Chrome 或 Edge 常规安装目录（如 Windows 的 `C:\Program Files\Google\Chrome\Application\chrome.exe` 等系统常规安装路径），并通过 `executablePath` 复用该常规浏览器；仅在没有找到任何可用本地浏览器时，才回退引导用户执行依赖下载，保证首次运行体验良好。

### 决策 3：CDP 隔离直连与本地持久化自建会话“双通道”设计
- **决策理由**：
  - **CDP直连通道**（`chromium.connectOverCDP(endpoint)`）：专为安全防范级别高、验证机制强（如带有 TLS 行为指纹与复杂反爬盾）的系统而设计。直接共享隔离浏览器中用户已通过扫码/人工录入的登录态，避免逆向自动化被封杀。
  - **持久化上下文通道**（`launchPersistentContext`）：供普通的自主自动化测试使用，所有状态（Cookie/缓存）物理存储于工作区隐藏文件夹 `.myagent/browser-session/`，保障跨任务运行的状态隔离。

### 决策 4：精简化可交互元素映射（AriaSnapshot DOM 标号映射）
- **决策理由**：大模型极难阅读数万行的 HTML DOM，极易迷失且严重浪费上下文。我们设计 DOM 解析程序在返回 Snapshot 时执行精简：只保留可交互组件（例如 `a`、`button`、`input`、`select` 等）和带有 `role` 属性的核心可访问性节点，并使用 `[@e1] Input`, `[@e2] Button` 等编号组织树。大模型在输出交互指令时只需传入元素 ID（例如 `ref: "@e1"`），由 Native Action 底层将其反射并映射回实际的 Playwright ElementHandle 执行点击或输入。

## 风险与权衡

| 风险点 | 影响 | 缓解策略/决策取舍 |
| :--- | :--- | :--- |
| **Playwright 内核体积过大** | 伤害极简 CLI 智能体的首次运行体验 | **引入 executablePath 常规浏览器扫描**：优先尝试在用户环境常规目录中寻找已有的 Chrome/Edge，仅在缺失时才 fallback 提醒用户下载。 |
| **Cloudflare 等高级风控阻拦** | `playwright-extra` 特征抹除技术容易随着反爬盾升级而失效 | **有头模式人机协同兜底**：不要绝对依赖 stealth 特征抹除。核心防御应对设计依然锁定在“检测到尚未登录 -> 弹出有头窗口（headless: false）由用户手动扫码/人工点击滑块 -> 命令行回车同步状态”。 |
| **CDP 直连主力浏览器会话污染** | 干扰用户正在进行的日常办公，且引发隐私安全担忧 | **强制引导调试隔离沙箱**：在文档与工具说明中，强制要求用户以独立参数形式拉起干净、专用的 Chrome 调试会话（例如指令：`chrome.exe --remote-debugging-port=9222 --user-data-dir="C:\temp\agent-chrome"`），不污染主力环境。 |
| **异步阻塞导致命令行死锁** | 提示登录挂起后无法有效唤醒 | **设计独立异步状态锁（Lock）**：在交互层 interface 与 brain 中使用状态同步锁，仅在捕获到用户输入回车符之后，才释放锁唤醒推理循环。 |
| **evaluate 闭包报错** | 部分转译器在嵌套具名函数上注入 `__name` 导致浏览器内 `ReferenceError` | **[Amend 修正] 逻辑内联与去回调化**：在 `page.evaluate` 作用域内部严禁声明任何嵌套具名函数（如 `isVisible` 等），并将 `forEach` 替换为原生 `for` 循环，杜绝任何外部编译器干扰。 |
| **内置工具目录割裂** | 错误地将浏览器相关工具文件保存在已废弃的 `native-tools` 目录 | **[调试修正] 浏览器控制模块六边形重构重定位**：在 `src/action/tools/` 下新建 `browser/` 子目录并移入所有浏览器控制文件，彻底移除旧的 `native-tools` 目录并更新链路引用，以符合六边形架构解耦一致性。 |
