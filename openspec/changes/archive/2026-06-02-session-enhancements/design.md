## 背景

目前 CLI 层的状态生命周期与进程生命周期强制绑定，无法跨重启续连；且输入流全部依赖用户的全拼输入。为了提升长期开发的连续体验，我们需要在底层设计一套基于文件的上下文持久化系统，并在外层 CLI 集成输入补全机制。

## 目标与非目标

**目标:**
1. 实现对 `SessionManager.messageHistory` 的 JSON 落盘。
2. 新增 `/history` 用于列出历史会话，`/resume <id>` 用于将 JSON 重新反序列化进 `messageHistory` 并覆盖当前上下文。
3. 挂载 readline completer 提供对已知斜杠命令的 Tab 补全。

**非目标:**
1. 不实现基于 SQLite 等关系型数据库的重量级持久化方案。
2. 不引入 Inquirer/Ink 等第三方高级终端库来重构输入菜单体系（坚持原生 Tab 补全）。

## 架构决策

- **落盘结构**：文件命名为 `.myagent/sessions/<sessionId>.json`。`sessionId` 采用 `Date.now()` 或基于日期时间的格式生成，在首次有效交互时写入，随后每轮对话结束（`isGenerating` 恢复时）更新覆盖。
- **干净启动原则**：系统启动时不自动加载任何遗留 Session，防止上次崩溃导致的残留阻碍新一轮开发。保持绝对的幂等干净态。
- **Tab 补全实现**：在 `createInterface` 选项中添加 `completer` 函数，对输入进行基于前缀（如 `/`）的子字符串匹配。若 `line.startsWith('/')`，则从已注册的指令列表中过滤出备选集。

## 风险与权衡

- **未闭合流数据污染**：如果 Agent 推理中断，落盘的最后一个 `message` 可能是一个损坏的 tool_call 或不完整的 reasoning。目前由于落盘动作放置在 `for await` 循环完全结束后，理论上可以避免“录入半句话”。若异常抛出（catch 分支），可选择跳过当次写入。
- **并发写入冲突**：由于是单线程单例 Agent，不存在并发写同一个 session json 的问题，使用 `fs.promises.writeFile` 直接覆写即可。
