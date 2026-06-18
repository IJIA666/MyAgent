# 探索主题: 解决模型接口调度中的 Object is not extensible 异常

## 1. 问题定义
在执行工作区清理任务时，智能体在获取到工具调用后，向 `SessionContext` 添加新消息（如 Assistant 消息或 Tool 消息）时发生崩溃，报错信息为 `模型接口调度失败：Cannot add property 2, object is not extensible`。

## 2. 关键发现与调研结果
- **代码库现状**：
  - 在 `src/brain/agent-loop.ts` 中，当模型下发工具调用（`tool_calls`）或完成（`complete`）时，会调用 `this.context.addMessage(finalAssistantMessage)` 将消息追加到 `SessionContext` 的 `messageHistory` 数组中。
  - 在大循环的每次迭代里，都会执行 Hook 管道（如 `BeforeModel`, `AfterModel` 等）。这些管道由 `src/brain/plugins/plugin-runner.ts` 中的 `runHookPipeline` 函数调度。
  - `runHookPipeline` 使用了 Immer 的 `createDraft` 和 `finishDraft`。默认情况下，Immer 在 `finishDraft` 时会**自动递归冻结（Deep Freeze）**它生成的最终状态。
  - 在 `runHookPipeline` 结束后，如果检测到历史记录发生变化，会通过 `sessionContext.updateHistory(finalState.history)` 把被 Immer 深度冻结的只读数组替换为 Context 的 `messageHistory`。
  - 随后，在 `agent-loop.ts` 的 `chat` 流中调用 `this.context.addMessage(...)` 时，底层通过 `this.messageHistory.push(message)` 修改该数组。由于当前的 `messageHistory` 数组已经被 Immer 冻结为只读，导致抛出 `Cannot add property 2, object is not extensible` 异常（当数组长度为 2 时，`push` 相当于向索引 2 赋值）。
- **核实与洞察**：
  - 经联网核实，Immer 默认开启 `autoFreeze`，以防止在 React 等框架中出现隐式状态突变。然而在后端/智能体等多轮交互场景中，主上下文数组需要在 Hook 流程之外进行可变的操作（如 push 消息）。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 A：全局关闭 Immer 自动冻结 | 方案 B：在 Hook 提交状态时对 history 数组进行浅拷贝解冻 | 选型分析 |
| :--- | :--- | :--- | :--- |
| **实现成本** | 极低（仅需在插件注册/调度处调用 `setAutoFreeze(false)`） | 极低（在 `plugin-runner.ts` 提交处使用 `[...history]`） | 均可轻易实现 |
| **架构契合度** | **高 ✓**。系统底层是面向对象（OOP）的可变状态（Mutable State）范式，关闭冻结完全适配了这种架构预期。 | **低 ✗**。强行将声明式 UI 的不可变机制（Immutable）混入 OOP 可变上下文，属于范式错配。 | 方案 A 占优 |
| **健壮性与防陷阱** | **高 ✓**。彻底解冻整个状态树，避免了后续任何针对已有消息属性的运行时修改（如流式内容追加、工具调用更新）报错。 | **低 ✗**。仅解冻了外层数组本身。数组内的 `message` 及其嵌套的 `tool_calls` 对象仍然处于递归冻结（只读）状态，极易在后续业务迭代中触发“不可分配只读属性”的隐形炸弹。 | 方案 A 占优 |
| **可维护性** | **极高 ✓**。一劳永逸。后续无需在各个数据提交点编写防冻结的防御性浅拷贝代码。 | **中等 ✗**。如果未来引入其他 Context 字段的 Hook 提交，也必须小心翼翼地逐个进行解冻操作。 | 方案 A 占优 |
| **性能影响** | **优 ✓**。在 finishDraft 时免去了对长文本会话历史进行全量递归扫描与冻结的 CPU 开销，在大上下文场景下性能更佳。 | **中 ✗**。需要承受深度递归冻结的性能损耗。 | 方案 A 占优 |

**推荐路径**：
**强推方案 A**。在 `src/brain/plugins/plugin-runner.ts` 的头部执行 `setAutoFreeze(false)` 全局关闭 Immer 自动冻结功能。
原因在于当前智能体的上下文（`SessionContext`）底层属于经典的可变状态（Mutable State）设计，且外部逻辑（如大循环中对消息的 `push`、流式消息的处理等）有强烈的就地修改预期。采用方案 B 只解冻外层数组会留下一具“外层可变、内层冻结”的半残废状态体，给未来的流式响应合并、工具补丁改写埋下巨大的隐形崩溃地雷。关闭自动冻结不仅在架构范式上高度统一，且具备更好的可维护性与在大上下文场景下的客观性能提升。

## 4. 约束、风险与未知项
- **外部突变风险**：关闭自动冻结后，如果中间件/插件开发者编写了不规范的直接突变外部原始对象（而非在 Draft 沙箱内修改）的代码，Immer 将无法通过异常报错来即时警示，这也要求插件的编写规范需要从开发规范上予以保证。

## 5. 否决方案
- **在 Hook 提交状态时对 history 数组进行浅拷贝解冻（方案 B）**：因其治标不治本，仅解决了数组 push 的问题，但对于数组内 message 元素及 `tool_calls` 子元素的冻结机制未予解除，严重割裂了状态访问体验，容易造成未来开发的调试地雷，故予以否决。

