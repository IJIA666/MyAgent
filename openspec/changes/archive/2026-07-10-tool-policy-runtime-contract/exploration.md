# 探索主题: 工具安全策略运行时契约

## 1. 问题定义

当前工具子系统已经完成“内建工具不再伪装成 MCP”的运行时统一，但安全策略仍残留旧的对象访问假设：`HumanApprovalPlugin` 期望从工具注册表取得带 `checkSafety()` 的真实工具对象，现行 `ToolRegistryPort.getTool()` 却只承诺返回 `ToolMetadata`。这不是普通类型瑕疵，而是授权决策能力在真实组合路径上不可达；同时，外部 MCP 工具没有进入同一套可信策略描述与执行约束。需要重新明确“工具目录、风险评估、用户审批、能力令牌、实际执行”五个环节的边界，而不是恢复已经移除的 virtual MCP 包装层。

## 2. 关键发现与调研结果

- **代码库现状**：`ToolCatalog.getToolMetadata()` 只返回 `name`、`securityCategory`、`executionMode` 和路径参数名；`ToolRegistryPort.getTool()` 的公开契约同样只有这些数据。`HumanApprovalPlugin.beforeToolMiddleware()` 却通过 `'checkSafety' in tool` 尝试调用安全判定。因此生产侧内建工具不会进入各自的 `checkSafety()`，而会统一落入“未知工具，默认挂起”分支。
- **实际行为后果**：工作区内的安全读取也会触发通用审批；审批产生的 `SafetyOperation.resources` 可能为空，无法表达用户究竟批准了哪个资源。工作区外路径即使获得一次审批，也可能因为没有可领取的资源能力而继续被底层路径守卫拒绝。用户看到的是一次看似有效、实际语义不完整的授权。
- **测试为何没有发现**：`human-approval-pending-grant.test.ts` 使用 `as unknown as HookContext['toolRegistry']` 注入了一个公开端口不可能返回的 `checkSafety` 字段，证明了插件自己的分支，却没有证明 `ToolRegistry -> HookContext -> HumanApprovalPlugin` 的真实组合契约。测试替身比生产端口更强，掩盖了断裂。
- **外部 MCP 边界**：`McpToolManager.getMcpTools()` 将服务端工具转换为模型函数定义时丢弃了 MCP `annotations`，`ToolCatalog` 也不为外部工具提供统一元数据。外部工具因而只能进入来源不明的通用挂起。它们执行在远端 MCP server，宿主无法用本地文件锁或备份可靠约束其副作用；正确边界是保留来源并实施精确 call 级审批，而不是把远端操作伪装成本地文件写入。
- **MCP 规范核实**：MCP 官方规范提供 `readOnlyHint`、`destructiveHint`、`idempotentHint`、`openWorldHint`，但明确说明它们只是提示，客户端不得依据不可信服务端的 annotations 独立做安全决策。这些字段可用于审批文案和保守分类，不能替代宿主侧确定性策略。[MCP ToolAnnotations 规范](https://modelcontextprotocol.io/specification/2025-11-25/schema)
- **OpenCode 对照**：OpenCode 的工具契约把 `ask(...)` 作为工具执行 `Context` 的显式能力，并由统一 Permission 服务评估规则；工具不需要通过一个只读目录对象反向暴露可执行安全方法。参考文件：`D:\projects\Agents\opencode\packages\opencode\src\tool\tool.ts`、`packages\opencode\src\permission\index.ts`。
- **Hermes Agent 对照**：Hermes 将危险命令检查放在终端工具实际执行入口，并显式传播 session、turn 和 tool-call 关联信息；后台非交互任务缺少审批通道时采用拒绝或受控策略，而不是让风险判定依赖进程全局的偶然对象形状。参考文件：`D:\projects\Agents\hermes-agent\tools\approval.py`、`tools\terminal_tool.py`、`tools\thread_context.py`。
- **OpenClaw 对照**：OpenClaw 把完整 `before_tool_call` 策略链做成独立运行时，并提供真实工具组合的 embedded/integration/e2e 测试，覆盖“没有审批路由时阻断”等生产边界。参考文件：`D:\projects\Agents\openclaw\src\agents\agent-tools.before-tool-call.ts` 及同目录测试。

## 3. 方案对比与推荐方向

| 评估维度 | 方案 A：让端口重新返回 `NativeTool` | 方案 B：把 `checkSafety` 塞进 `ToolMetadata` | 方案 C：独立 `ToolPolicyPort` | 结论 |
| :--- | :--- | :--- | :--- | :--- |
| 核心层与适配器隔离 | 核心层重新依赖适配器工具对象 | 名为 metadata，实为可执行策略，职责混杂 | 目录数据与策略能力显式分离 | C 最清晰 |
| 内建工具迁移成本 | 低，但倒退到旧边界 | 中 | 中，需要为现有 `checkSafety` 提供适配 | C 可控 |
| 外部 MCP 支持 | 仍无统一答案 | 可硬塞一个通用函数 | 可按服务信任级别、annotations 和宿主策略组合 | C 最完整 |
| 测试可证伪性 | 容易继续伪造过强对象 | 仍可能用结构类型掩盖错误 | 可对策略端口做契约测试，并用真实注册表做组合测试 | C 最强 |
| 安全失败方式 | 依赖对象是否泄漏成功 | 依赖可选函数字段 | 缺少策略提供者时明确 fail closed | C 最稳定 |

**推荐路径**：新增独立的工具策略端口，输入只读的工具调用描述，并将当前 `SessionEventPort` 作为独立运行时参数传入；输出直接复用现有 `SafetyCheckResult`，不再制造与 `status: pass | suspend | deny` 重复的第二套决策模型。内建工具现有 `checkSafety()` 通过同一批 `NativeTool[]` 构造的适配器接入该端口；`HumanApprovalPlugin` 只消费策略结果，不再从工具目录探测方法。外部 MCP 在本变更中保持保守挂起，annotations 仅用于审批文案；没有确定性资源提取器时，只允许精确 call 级授权，不生成 session 或 persistent 授权。`ToolExecutor` 继续只负责执行前领取能力，现有能力注册、领取和 finally 消费时序不变。

## 4. 约束、风险与未知项

- 必须保持当前正确方向：内建工具不重新依赖 MCP，也不恢复 `LocalFileSystemMcpServer` 兼容层。
- 需要决定 `checkSafety()` 最终是保留在工具实现上由策略适配器调用，还是逐步迁移为独立策略定义；推荐先适配、后按工具族渐进拆分，避免一次性重写全部工具。
- 外部 MCP 的 annotations 不能被视为可信授权事实；服务信任必须来自本地配置或安装来源，默认值应保守。
- MCP 工具可能操作文件以外的资源。资源模型不能继续假设所有未知操作都是 `file-write`，应允许 `network`、`process`、`external-service`、`opaque` 等宿主可理解的类别。
- 主调用与 tail call 必须分别使用独立 `toolCallId` 经过 BeforeTool 策略评估；AfterTool 不重复做前置授权。并发锁与备份继续遵循现有本地工具元数据和参数边界，不把远端 MCP 副作用伪装成本地文件资源。
- 需要用真实 `ToolRegistry` 和至少一个真实内建工具补充组合测试，证明 safe、deny、suspend 三条路径均可达；仅测插件假对象不构成完成。

## 5. 否决方案

- **恢复 `getTool(): NativeTool`**：否决。它会重新泄漏适配器实现，并抵消刚完成的端口隔离。
- **在插件中继续使用类型断言探测 `checkSafety`**：否决。结构类型可以让测试通过，却无法建立生产契约。
- **完全信任 MCP annotations 自动放行**：否决。官方规范明确将其定义为不可信提示。
- **所有工具永久统一弹窗**：否决。它看似 fail closed，实际上抹平安全读取与高风险写入，诱发审批疲劳，且仍不能生成正确资源能力。
- **把安全检查下沉到每个工具内部且取消统一前置策略**：否决。这样无法在执行前稳定展示审批、统一处理外部 MCP，也无法保证所有调用路径一致。
