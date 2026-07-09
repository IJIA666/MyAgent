# 探索主题: 生命周期与授权作用域边界重整

## 1. 问题定义
当前系统将 `SessionStart` / `SessionEnd`、单次 `chat/run`、单轮 `iteration`、审批授权作用域这几类边界混在了一起，导致生命周期命名与真实行为不一致，并进一步影响 `session` 级授权、插件语义和后续架构演进。核心问题不是“命名不优雅”，而是系统已经出现了**边界错位带来的实际行为偏差**。

## 2. 关键发现与调研结果
- **代码库现状**：
  `AgentLoop.chat()` 在进入时触发一次 `SessionStart`，但 `SessionEnd` 被放在 `while (iteration < this.maxIterations)` 循环体的 `finally` 中，因此它实际上会在每一轮迭代结束时触发，而不是真实会话关闭时触发。对应位置见 `src/core/usecases/engine/agent-loop.ts:204-216`、`src/core/usecases/engine/agent-loop.ts:1093-1106`。
- **代码库现状**：
  `SessionEnd` 触发后立即执行 `clearTemporaryWhitelists()`，这会清空当前会话中的临时读写白名单。由于 `session` 级审批授权正是通过这些白名单承载，因此“会话始终放行”在实现上只活到当前迭代结束。对应位置见 `src/core/usecases/engine/agent-loop.ts:620-640`、`src/core/usecases/engine/agent-loop.ts:1093-1106`。
- **代码库现状**：
  `ApprovalPolicy` 明确把 `session` 选项表述为“会话始终放行”“本次会话内所有相同操作自动放行”，这与当前实现中的“单迭代有效”是直接冲突的。对应位置见 `src/core/usecases/security/ApprovalPolicy.ts:53-55`。
- **代码库现状**：
  多个插件把 `SessionEnd` 当成真实会话结束点使用，而不是“单轮推理结束”。例如 `LongTermMemoryPlugin` 的类注释和 Hook 注册都将其视为“会话结束时异步提炼”，`TracerLogPlugin` 也把它作为生命周期审计点。对应位置见 `src/core/usecases/plugins/LongTermMemoryPlugin.ts:14`、`src/core/usecases/plugins/LongTermMemoryPlugin.ts:55-56`、`src/core/usecases/plugins/TracerLogPlugin.ts:82-87`。
- **代码库现状**：
  `SessionManager.close()` 并不会触发任何 `SessionEnd` Hook，它只是执行 `abort()`、拒绝挂起审批、清理交互、关闭工具注册表。这说明系统当前甚至不存在“真实 session 结束”的 Hook 边界。对应位置见 `src/core/usecases/engine/session.ts:342-355`。
- **核实与洞察**：
  MCP 官方规范将连接生命周期明确拆成 `Initialization / Operation / Shutdown` 三段，强调能力协商和关闭边界必须独立建模，而不是混入普通操作阶段。[MCP Lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)
- **核实与洞察**：
  OpenAI 官方文档也将“长寿命 conversation 对象”和“基于 previous_response_id 串起来的 response 链”分开建模，说明长期状态边界与单次响应边界本就不应混为一谈。[Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)
- **核实与洞察**：
  结合本仓库当前实现，可以把真实边界至少拆成四层：`call`（单工具调用）、`run/chat`（一次推理任务）、`session`（当前会话实例生命周期）、`persistent`（跨会话持久规则）。其中 `iteration` 只是 `run` 内部循环机制，不应伪装成 `session` 生命周期事件。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 A：维持现状，仅修文案 | 方案 B：把当前 Hook 重命名为 `RunEnd` 或 `IterationEnd` | 方案 C：补真实 session 生命周期，并重整授权作用域 | 结论 |
| :--- | :--- | :--- | :--- | :--- |
| 语义一致性 | 低 | 中 | 高 | C 明显占优 |
| 对现有 bug 的修复能力 | 无 | 只能修命名错位，不能修授权行为 | 可同时修命名和行为 | C 才能闭环 |
| 对插件影响 | 表面最小，但继续误导插件 | 中等，需要改 Hook 订阅点 | 中高，需要梳理插件意图 | C 成本更高但正确 |
| 审批模型可扩展性 | 低 | 中 | 高 | C 更适合后续扩展 |
| 与外部成熟模型对齐程度 | 低 | 中 | 高 | C 更符合分层生命周期建模 |

**推荐路径**：
采用方案 C，并按“两步走”推进，避免一次性重构过深。

第一步，先把现有事件语义拉直：
- 将当前 `SessionStart` / `SessionEnd` 重命名为更贴近真实行为的 `RunStart` / `RunEnd`，或最少把 `SessionEnd` 改成 `RunEnd`。
- 明确 `iteration` 只是 `AgentLoop.chat()` 内部的控制流循环，不单独对外冒充会话生命周期。

第二步，再补真实生命周期与授权作用域：
- 在 `SessionManager` 层引入真实 `SessionOpened` / `SessionClosing` / `SessionClosed` 边界。
- 将临时白名单清理从当前 `AgentLoop` 的 `finally` 移到真实 session 结束点，或改为按作用域精确清理。
- 将授权作用域显式定义为：
  `call`：仅当前工具调用有效；
  `run`：仅当前一次 `chat/run` 有效；
  `session`：仅当前 `SessionManager` 实例生命周期有效；
  `persistent`：落盘后跨会话有效。
- 如果后续仍保留 `session` 级选项，就不能再用“每次 run 结束清空全部临时白名单”的机制承载它，否则语义仍然失真。

## 4. 约束、风险与未知项
- 如果直接修改 Hook 名称而不同时调整插件，会造成 `LongTermMemoryPlugin`、`TracerLogPlugin`、`LoopPreventionPlugin` 等现有行为改变，需要逐个复核其真正意图。
- 当前 `SessionContext` 同时承载消息历史、审批服务、挂起交互、call capability、临时白名单桥接；即便完成本次边界重整，后续仍可能需要进一步拆分状态职责。
- `run` 级授权是否需要长期存在于产品语义中，当前代码尚未显式表达。若没有明确场景，也可以只保留 `call / session / persistent` 三层，但必须先把 `session` 边界修正为真实 session 生命周期。
- 自动唤醒链路会重复调用 `runInternalGeneration()`；如果未来把 `run` 作为外显作用域，需要明确“自动唤醒是否仍属于同一个 run”，否则仍会出现作用域歧义。

## 5. 否决方案
- **维持 `SessionEnd` 命名，仅修改审批文案**：否决。这样会继续误导插件作者和后续维护者，属于把结构性问题伪装成提示词问题。
- **保留当前 `SessionEnd`，但单独给 `session` 授权开一个特殊白名单容器**：否决。这样会把同一套授权体系拆成两套隐含机制，增加理解成本和状态同步风险。
- **把 `session` 授权直接降级成 `run` 授权**：否决。除非产品语义明确取消“会话始终放行”，否则这是悄悄改需求，不是修架构。
