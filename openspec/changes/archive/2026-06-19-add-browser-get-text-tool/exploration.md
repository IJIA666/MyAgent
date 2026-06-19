# 探索主题: 网页原生文本提取工具 add-browser-get-text-tool

## 1. 问题定义
在当前的智能体（Agent）底座中，唯一的网页内容感知手段是通过 `generateAriaSnapshot` 方法。该方法使用了严格的可交互元素选择器（如 `a`, `button`, `input` 等），导致页面中的普通排版文本、文章段落以及非交互展示类文本被全部滤除。当智能体导航到纯信息展示网页（例如 DeepSeek 历史会话的聊天日志、SPA 文档页面等）时，由于缺乏交互元素，智能体只能获得极其简短的标题链接或者干脆是“未探测到任何可见的可交互元素”的信息。这使得智能体沦为“盲人”，彻底丧失了提取网页正文信息与内容分析的能力。

本探索旨在通过规划并新增一个原生浏览器工具 `browser_get_text`，解决该痛点，让智能体能够提取指定区域或整个网页的干净、可见文本内容。

## 2. 关键发现与调研结果
- **代码库现状**：
  - 现有的浏览器感知仅依赖于 `src/action/tools/browser/browser-action.ts` 中的 `generateAriaSnapshot`。
  - 浏览器操作底层使用 Playwright 驱动，多租户隔离状态由 `BrowserSession` 单例维护。
  - `virtual-mcp.ts` 负责接收工具的分发，并注册为虚拟 MCP 接口暴漏给大模型。
- **核实与洞察**：
  - 通过联网检索，Playwright 原生提供的 `locator.innerText()` 方法非常契合我们提取“人类可见”文本的需求。
  - 区别于 `textContent` 会把 `<script>` 和 `<style>` 的代码逻辑及 CSS 原样输出导致大量 Token 损耗，`innerText` 在浏览器渲染层工作，不仅自动过滤了 `<script>`、`<style>` 等非内容节点，还能自动过滤受 CSS 规则隐藏（如 `display: none`、`visibility: hidden`）的元素文本。
  - 必须防范 Playwright Locator 的**严格模式冲突**（Strict Mode Violation）：当 CSS 选择器在页面匹配了多个节点时，直接调用 `locator.innerText()` 会抛出异常崩溃。我们可以通过 `locator.all()` 提取所有元素数组再循环处理来彻底解决该问题。
  - **竞品调研（Hermes-Agent）**：
    - 在开源项目 `hermes-agent` 中，网页内容的感知根据任务属性采用了**纯信息检索（只读）**与**浏览器交互快照（可写）**的两层分流体系：
      1. **只读检索层 (`web_extract`)**：针对不需要人机交互的纯文本数据爬取，底层通过 Firecrawl 等第三方转换服务将网页还原为 Markdown。为了应对超长页面（支持 5k - 500k 字符）导致的 Token 损耗，Hermes 专门配置了辅助模型（Auxiliary Model）执行单次概要提取（Single-pass summary），强制将输出体积收束在约 5,000 字符内。
      2. **交互快照层 (`browser_snapshot`)**：当涉及点击、填充表单等浏览器自动化时，Hermes 使用基于 aria 属性的无障碍树快照提供含 `@eN` 编号的紧凑视图。为了防范庞大页面带来的性能崩溃，Hermes 在底层做出了 **8,000 字符的硬性快照长度上限拦截（8k-char cap）**。
  - **竞品调研（OpenClaw）**：
    - 在开源项目 `openclaw` 的 `extensions/web-readability` 中，网页纯文本和可读性 Markdown 的提取有一套不依赖真实运行浏览器的**纯内存 DOM 解析净化链路**：
      1. **技术选型**：它采用 `@mozilla/readability`（经典的阅读模式正文抓取算法）配合 `linkedom`（轻量级、无 headless 开销的内存 DOM 树解析器）进行新闻、文章、长文的降噪解析，剔除页面上所有的广告、侧边栏和多余导航区。
      2. **多重防爆阈值**：在数据过滤和提取时设置了严苛的三重安全关卡：首先对 HTML 进行 `sanitizeHtml` 净化；其次设定 HTML 字符数上限为 `1,000,000` 字符；最后限制 HTML 节点的嵌套深度最大为 `3,000` 层。超出任意一项则予以直接拦截。
      3. **提取模式**：支持 Markdown 提取和纯文本提取两种模式。在纯文本模式下会对结果运行 `normalizeWhitespace`（规范化空白）和 `stripInvisibleUnicode`（剥离不可见字符）以保障输出最纯净。
  - **参考借鉴**：
    1. Hermes 与 OpenClaw 针对大文本网页设置的**硬性长度限制**、**辅助模型摘要压缩**以及**多重物理阈值过滤**，强力佐证了我们在本设计中引入“执行层 80,000 字符物理安全截断”和“Schema 强语气规制”这一物理性防爆防御决策的安全性和必要性。
    2. OpenClaw 对页面文本降噪（剔除不可见 Unicode、空白规整）的方法具有极强的借鉴意义。在我们的 `browser_get_text` 方案中，我们使用的 Playwright `innerText` 虽然天然排除了样式与隐藏文字，但在多节点合并阶段也可以执行必要的空白折叠（如将连续多行的空行压缩为最多双换行 `\n\n`）来进一步优化大模型 Token 的开销。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 A (自定义递归 evaluate) | 方案 B (原生 locator.innerText) | 结论 |
| :--- | :--- | :--- | :--- |
| **开发成本** | 中（需要在 evaluate 中手工编写繁琐的 DOM 深度递归及样式判定逻辑） | 低（直接调用 Playwright 官方原生封装的 API） | 方案 B 占优 |
| **可维护性** | 弱（随着浏览器渲染引擎的升级或边界 DOM 树的变化容易产生隐蔽 Bug） | 强（依托 Playwright 物理底座的持续迭代与测试保证） | 方案 B 占优 |
| **性能表现** | 较差（使用纯 JS 深度递归全树，在庞大 DOM 时 CPU 占用明显） | 较好（底座直接使用 C++ 进行渲染层布局计算，速度更快） | 方案 B 占优 |
| **过滤效果** | 手工判定 `getComputedStyle` 较难覆盖全部 CSS 特效（如父级隐藏） | 完美（原生结合 Layout tree 自动感知所有人类可见内容并过滤 Noise 标签）| 方案 B 占优 |
| **多匹配支持**| 需自行合并返回 | 通过 `locator.all()` 分拆循环调用，有效避免 Strict Mode 报错 | 方案 B 占优 |

**推荐路径**：
选择 **方案 B (原生 locator.innerText)**。通过 Playwright 的 `.locator(selector).all()` 配合 `innerText()` 循环处理并使用双换行符拼接。这能够以最少、最稳定、最高效的代码实现对 SPA 等页面的高精准度降噪文本提取。

## 4. 约束、风险与未知项
- **Token 暴涨风险**：若不传入 CSS Selector，默认提取 `body` 可能会拉出极其庞大的无用全局文本（例如页脚免责声明、巨型侧边导航等）。我们需要在智能体系统指令中引导其“优先传入精确的 Selector 提取核心正文”（如 `.chat-message`、`article` 等）。
  - **入参设计强化**：在后续起草 spec.md 或编写工具的 JSON Schema 时，将 `selector` 设为可选参数，但在 description 中着重使用强烈语气告诫大模型：“若需阅读整篇文章或列表，请务必传入精确的 CSS Selector（如 .article-content, .list-items）。只有在完全无法定位时，才允许不传选择器（默认提取全页面，风险极高）”。
  - **截断防御机制**：在执行层（execute）引入硬性字符长度限制（如对提取出的最终合并字符串执行 `.slice(0, 80000)`），截断超长无效文本，避免少数极端失控页面产生长达数兆的文本流，引发下游处理环节的内存崩溃或 Token 超载。
- **页面刷新与死锁**：必须确保 `browser_get_text` 也是基于 `BrowserSession.getPage(undefined, tenantId)` 实例，不会引起多租户会话冲突或重建，同时其安全属性应定义为只读（`read`）。

## 5. 否决方案
- **直接使用 locator.textContent() 提取**：被彻底舍弃。因为 `textContent` 会把 `<script>` 和 `<style>` 的底层源码连带输出，造成严重的 Token 资源浪费和幻觉噪声。
- **自定义 DOM 树克隆后在内存剔除 noise 标签**：被舍弃。因为内存中克隆出来的 DOM 树（不在 document 树中）调用 `innerText` 由于失去 Layout layout tree 计算，返回值会恒定为空，极易产生空结果 Bug。
