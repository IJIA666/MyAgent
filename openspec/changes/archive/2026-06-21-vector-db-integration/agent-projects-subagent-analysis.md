# 竞品项目子代理（ Sub-Agent ）管理机制调研分析

## 1. Claude Code 子代理机制 ( 内存与工具链级隔离 )

- **引擎深度重用**： 子代理不需要独立的进程管理器或重型框架基座， 而是通过直接复用底层的核心对话引擎 `query` 来跑一个 ReAct 大循环。

- **上下文深隔离**： 启动子代理前， 利用 `createSubagentContext` 构造隔离的 `ToolUseContext`。 将主智能体修改 UI（ 如 `addNotification` ） 的修改器设为 `no-op`， 且对文件状态缓存 `readFileState` 实施深拷贝， 防止主对话状态被破坏。

- **静默权限核查**： 强行在子代理的 AppState 中将 `shouldAvoidPermissionPrompts` 设为 `true`。 在后台静默运行所有工具审批， 避免打扰用户交互， 辅以白名单权限锁定。

- **工具权限锁定**： 子代理的 `getAppState` 中只注入限定白名单内的 allowedTools， 彻底剔除了命令执行与全量写文件等高危能力， 阻止 Prompt 注入导致的越权逃逸。

---

## 2. OpenCode 子代理机制 ( 数据与服务层分支机制 )

- **会话分支克隆**： OpenCode 采取了 **“ 会话分支 ( Session Fork ) ”** 的设计理念。 在派生子智能体时， 会调用底层服务端的 `session.fork` 接口直接克隆原有的 `sessionId` 关系， 生成全新的 `forked.id`。

- **历史快照继承**： 子会话生成后， 通过 `session.messages` 服务拉取并恢复原父会话的部分历史消息， 从而继承其模型配置、 变体（ variants ）、 运行模式等快照状态， 极大提高了 Prompt Caching 的命中率。

- **物理连接隔离**： 每一个分支出来的子会话在本地都拥有专属的物理实体状态， 会被独立使用 `registerMcpServers` 绑定只属于该子会话的 MCP 工具服务， 确保工具运行空间的物理隔离。

- **轻量并发流转**： 子会话在底层基于现代 `Effect-TS` 的协程光纤（ Fiber ） 并发模型进行流式驱动， 实现对不同 SessionID 推理请求的物理并发与优雅中断。

---

## 3. Hermes Agent 子代理机制 ( 主从级联与线程沙箱隔离 )

- **主从级联委派**： Hermes Agent 采用主从（ Orchestrator-Worker ） 协同设计， 通过 `delegate_task` 工具同步拉起隔离的子 `AIAgent` 实例。 支持通过 `tasks` 数组在 `ThreadPoolExecutor` 中多线程并行处理， 并可在全局配置 `max_spawn_depth` 内进行多层嵌套委派。

- **上下文与沙箱**： 子智能体在启动时被强制设置为全新对话， 对父智能体历史“一无所知”， 仅继承凭据池。 每一个子智能体在操作系统层面挂载独立的终端会话（ Terminal Session ）， 且通过禁用 `clarify`、 `memory` 等工具杜绝跨会话污染。

- **静默非交互审批**： 在子线程初始化时， 绑定非交互式审批回调 `_set_subagent_approval_cb`。 任何需要高危动作确认的弹窗将被静默拦截并拒绝（ 或按配置处理 ）， 彻底规避后台异步线程对 TUI 造成死锁。

- **最终摘要与级联**： 子代理详细轨迹不进主上下文， 仅向父智能体返回精炼后的 `summary` 结果 JSON 字符串， 并自动将子智能体的 token 和费用累加至父智能体。 支持主智能体中断信号（ interrupt ） 级联向所有运行中的子、 孙智能体传播以防止僵尸进程。

---

## 4. OpenClaw 子代理机制 ( 语音桥接与快照分支克隆 )

- **语音会话咨询**： OpenClaw 提供了智能体咨询工具 `openclaw_agent_consult`。 当实时语音智能体需要获取后台工具能力或工作区知识时， 会以咨询（ Consultation ） 形式将请求委派给嵌入的正常工具链 Agent 执行。

- **自适应快照分支**： 在委派克隆前通过 `resolveParentForkDecision` 评估父会话 Token 数量是否超过 10 万阈值。 超过则回退为隔离全新会话启动以防 Token 暴涨； 未超过则执行物理 `session.fork`， 复制父会话 JSONL 快照并生成 parent 引用链。

- **静默过滤输出**： 子智能体在执行嵌入式咨询运行时， 将其调试及隐藏推理日志级强制设为 `off`， 并通过 `collectRealtimeVoiceAgentConsultVisibleText` 物理过滤掉任何带有 `isReasoning` 和 `isError` 的中间数据片段， 保证仅返回最精简的 speakable 纯文本。

- **精细权限降级**： 根据咨询策略， 支持自动为子会话降级工具权限。 比如在 `safe-read-only` 模式下仅暴露读、 搜索及记忆读取等只读工具， 拒绝写盘及命令执行， 保障委派过程的物理安全。

---

## 5. 对本项目的架构启示与佐证

- **印证当前设计**： 调研的四款主流竞品均未设计额外庞杂的 Sub-Agent 物理实体类。 它们本质上都是通过对**核心会话/执行大循环的局部参数重构、分支或实例化隔离**来达成子代理概念的。

- **验证解耦价值**： 本项目第二阶段采取的“ 回调向上传递 + Session 协调层 Fork 隔离 AgentLoop 对象 ” 的设计， 在思路上与各大竞品重用核心引擎并限制工具的做法高度一致， 最具落地性价比。

- **安全防御细节**： 借鉴 Hermes 与 OpenClaw 做法， 在拉起隔离子智能体时， 限制其能够调用的工具集（ 比如仅允许写死保存路径为 `.agent/MEMORY.md` 的 `writeMemoryFile` 工具 ）， 且拦截其用户交互与长期记忆访问， 规避越权命令执行及文件篡改风险。

- **性能优化启发**： 借鉴 OpenClaw 的 admission 准入检查， 在父会话过大时可考虑回退为隔离（ Isolated ） 提炼， 避免继承极其庞大的历史导致 Token 开销暴涨和上下文溢出， 并支持剔除隐藏的 reasoning 过程。

