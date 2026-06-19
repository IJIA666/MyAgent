## 新增需求

### Requirement: 浏览器控制通道探测与复用
工具引擎必须（MUST）在启动前检测本地操作系统常规路径，查找是否存在已安装的主流浏览器（Google Chrome 或 Microsoft Edge）。如果检测到可用常规浏览器，应当（SHALL）优先复用该常规浏览器，以避免强制下载大体积的 Chromium 内核。

#### Scenario: 成功检测并复用本地 Chrome 浏览器
- **WHEN** 智能体首次尝试调起本地浏览器工具，且本地 Windows 系统的默认安装目录中存在可用的 Google Chrome 浏览器。
- **THEN** 智能体工具层通过 executablePath 指定复用本地已安装 of Chrome，成功渲染页面，而不需要在后台下载 Playwright 官方 Chromium 包。

#### Scenario: 本地无常规浏览器则回退提示
- **WHEN** 智能体尝试检测本地常规目录，没有发现任何可用的 Chrome 或 Edge 安装路径。
- **THEN** 工具应当（SHALL）自动下载或给出具体的依赖下载指南提示，并回退至隔离 Chromium 包。

### Requirement: CDP 直连与本地 Profile 双通道会话共享
工具必须（MUST）支持配置 CDP 远程调试直连端口与本地 Profile 持久化存储。当指定 `cdpUrl` 调试参数时，必须（MUST）直连指定端口；否则，必须（MUST）持久化缓存 Cookie 到项目工作区内隐藏的本地物理路径。

#### Scenario: 通过 CDP 端口共享隔离调试浏览器状态
- **WHEN** 智能体传入 `cdpUrl`（例如 `http://127.0.0.1:9222`）来实例化页面。
- **THEN** 工具通过 connectOverCDP 连接到对应的端口，智能体直接在该独立调试窗口中操作，无需重新执行输入账号密码及验证流程即可获得原浏览器的登录态。

#### Scenario: 通过本地 Profile 持久化会话
- **WHEN** 智能体在未配置 `cdpUrl` 情况下实例化页面，访问特定登录后的系统。
- **THEN** 工具利用 launchPersistentContext 启动浏览器，指定会话路径为 `.myagent/browser-session/`。登录成功后，Cookies 自动物理保存；第二次运行智能体时能免登录直接访问该页面。

### Requirement: 人机风控与扫码登录的命令行协作阻塞
当智能体检测到尚未登录或被滑动验证码、扫码验证等风控拦截时，必须（MUST）在终端暂停大模型推理循环，调起有头浏览器窗口，阻塞等待用户在弹窗中人工干预。用户完成登录后在命令行按回车以释放阻塞。

#### Scenario: 用户人工扫码后命令行回车激活
- **WHEN** 智能体检测到页面停留在“请输入验证码”或“请微信扫码登录”页面。
- **THEN** 智能体在命令行终端打印明显的黄色高亮警告：“已调起浏览器有头窗口，请在弹窗中手动扫码/过滑动验证，完成后在此处按回车键以继续...”，并且暂时挂起（阻塞）推理。当用户扫码成功并回到终端按下回车后，智能体刷新页面 Snapshot 并同步状态，继续自动推理。

### Requirement: DOM 交互节点简化与标号映射
返回给大模型的页面 Snapshot 必须（MUST）进行大幅度节点精简，提取交互元素并进行数字标号映射（例如 `@e1`, `@e2`）。大模型交互时必须（MUST）通过传入标号来指代具体的 DOM 节点。

#### Scenario: 智能体通过标号精确点击页面按钮
- **WHEN** 大模型获取到包含 `[@e5] Login Button` 的精简网页文本 Snapshot，并计划点击该登录按钮。
- **THEN** 大模型调用 `browser_click(ref: "@e5")`，工具层接收到该标号后，自动反射映射到实际对应的 Playwright ElementHandle 并执行 `element.click()`。
