## 背景

MyAgent 当前的人机交互仅限于安全审批通道——`HumanApprovalPlugin` 在写操作前通过 `ApprovalPort.waitApproval()` 挂起 agent-loop，CLI 渲染安全警告并等待用户 yes/no 决策。该通道的语义是"拦截风险操作"，不是"对话提问"。

`NativeTool.execute()` 的签名为 `execute(args, _sessionContext?: SessionEventPort, signal?: AbortSignal)`，`ApprovalPort` 在调用链中已存在（`virtual-mcp.ts` 的 `callTool` 接收 `SessionEventPort & ApprovalPort`）但类型上未暴露给工具。工具层无法直接发起挂起等待。

## 目标与非目标

**目标:**
- agent 在推理过程中能通过原生工具调用向用户发起结构化提问
- 支持固定选项选择（单选/多选）、自由文本输入、混合模式
- CLI 渲染与现有审批弹框在视觉和语义上明确区分
- 工具 `execute()` 可以同步挂起等待用户回答，结果作为字符串返回模型
- 纯增量开发，不修改 agent-loop 核心循环逻辑

**非目标:**
- 不改变现有审批系统的行为或 UI
- 不引入 Plan 模式的两阶段协议代码改动（依赖现有 WorkMode 切换）
- 不支持文件上传、图片选择等复杂交互形态（本次仅文本）
- 不提供流式或分步多轮提问（每次调用一问一答）

## 架构决策

### 决策 1：AskUserQuestion 作为 Native Tool 实现

**选择**：注册为 `NativeTool`（`securityCategory: 'read'`），实现 `execute()` 方法内部挂起等待用户输入。

**理由**：工具调用是 agent-loop 的天然暂停点。`virtual-mcp.ts:175` 的 `callTool()` 方法已持有 `SessionEventPort & ApprovalPort`，挂起基础设施（suspend 事件 + 等待恢复）已成熟。模型通过标准 tool-use 范式主动调用，无需 prompt 约定或事件机制。

**替代方案**：
- 插件方案：被否决——插件适合横切关注点，不适合做核心交互原语
- 系统事件方案：被否决——事件模型是异步通知，AskUser 语义是同步等待

### 决策 2：新增 `InteractionPort` 而非复用 `ApprovalPort`

**选择**：新建 `InteractionPort` 接口，提供 `askUser(payload: AskUserPayload): Promise<string>` 方法。`NativeTool.execute()` 签名扩展为接收 `SessionEventPort & InteractionPort`。

**理由**：`ApprovalPort.waitApproval()` 的语义是"安全拦截——此操作有风险"，CLI 渲染的是安全警告界面。AskUserQuestion 的语义是"正常对话——我想问你一个问题"。两者共用同一方法会导致 CLI 层无法区分渲染逻辑，用户体验上所有提问都会被呈现为安全警告。

`InteractionPort` 承载的是"对话式等待"，与安全性解耦。CLI 层根据 Port 类型差异化渲染。

**数据结构**：
```typescript
interface AskUserPayload {
  title: string;               // 问题标题
  options?: string[];          // 预设选项（可选）
  multiSelect?: boolean;       // 多选，默认 false
  allowFreeInput?: boolean;    // 自由输入，默认 false
}

interface InteractionPort {
  askUser(payload: AskUserPayload, signal?: AbortSignal): Promise<string>;
}
```

**子决策：`InteractionPort` 注入方式**

`NativeTool.execute()` 当前签名为 `execute(args, _sessionContext?: SessionEventPort, signal?: AbortSignal)`。将 `InteractionPort` 暴露给工具有两条路径：

| 路径 | 做法 | 优缺点 |
|:---|:---|:---|
| A | 并入 `_sessionContext`：`SessionEventPort & InteractionPort` | 简洁，但污染 `SessionEventPort` 的语义——未来所有工具拿到的 sessionContext 都包含交互能力，即使它们永远不需要 |
| B | 新增独立参数：`_interactionPort?: InteractionPort` | 职责清晰，只有需要交互的工具才关心这个参数。与 design.md "独立接口" 精神一致 |

**选择路径 B**：`execute(args, _sessionContext?: SessionEventPort, _interactionPort?: InteractionPort, signal?: AbortSignal)`。`_interactionPort` 作为独立可选参数，仅 `AskUserQuestionTool` 使用，其他工具不受影响。

### 决策 3：CLI 渲染与审批弹框共享底层通道但 UI 分离

**选择**：CLI 层 (`facade.ts`) 维护一个统一的"交互处理器注册表"，根据交互来源（审批 vs 提问）路由到不同的渲染函数。底层复用 `readline` 的 stdin 抢占机制。

**理由**：底层技术需求一致（暂停 InputListener → 渲染 UI → 等待输入 → 恢复 InputListener），共享基础设施避免重复造轮子。但渲染层分离确保用户能区分"系统在问我问题"和"系统在警告我风险"。

### 决策 4：工具定义放置在 `src/adapters/tools/impl/interaction/`

**选择**：新建 `interaction` 子目录，与 `filesystem/`、`skill/`、`browser/` 同级。包含 `ask-user-question.ts` 工具类 + `index.ts` 导出。

**理由**：与现有工具分类模式一致。`interaction` 作为一类独立工具领域（人机交互），后续可扩展（如 `confirm_action`、`show_progress` 等）。

## 风险与权衡

| 风险 | 缓解策略 |
|:---|:---|
| `NativeTool.execute()` 签名扩展（增加 `InteractionPort`）影响所有现有工具的类型定义 | 将新参数设为可选（`_interactionPort?: InteractionPort`），现有工具无需修改。后向兼容 |
| 模型可能过度调用 `ask_user_question`，导致频繁打断 | 在系统提示词中软约束：仅当需要用户决策或信息不足时调用，不应在确定性操作中提问 |
| 多选 + 自由输入混合模式交互复杂度高 | 初版仅支持单选/多选/自由输入的纯模式。混合模式（选几项 + 手写补充）降级为两次独立调用或留到后续迭代 |
| CLI 在等待用户回答期间，agent-loop 完全阻塞 | 与审批挂起行为一致，是预期行为。未来可考虑超时自动回退（defaultAnswer 参数），本次不做 |

## 待确认问题

- `InteractionPort` 的实现是否需要像 `ApprovalPort` 那样支持 5 分钟超时自动拒绝？初版建议超时后返回空字符串，由模型自行处理
- `ask_user_question` 工具在系统提示词中是否需要特殊说明使用场景？建议在 `system-reminder` 层简单描述其用途即可，模型根据 tool definition 的 description 自行决策
