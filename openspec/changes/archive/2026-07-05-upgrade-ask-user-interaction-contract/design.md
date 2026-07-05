## 背景

当前 `ask_user_question` 的问题已经不是单一 UI 缺陷，而是“提问契约、恢复链路、CLI 渲染”三层同时失配：

- `CliFacade` 没有对同一 `interactionId` 做活动 UI 幂等保护，`interaction_request` 与 `/resume` 可能把同一个挂起提问重复拉起。
- 提问模型仍是单题 `title/options`，无法把不同语义维度拆成多个独立问题，也无法稳定表达结构化选项与多选答案。
- ask 交互仍在维护手写 `readline` 分支，而仓库主路径已经采用 `@clack/prompts`，继续分叉只会累积更多一致性债务。

## 目标与非目标

**目标：**
- CLI 层对同一 PendingInteraction 的重复 UI 拉起幂等（`interaction_request` 事件 + `/resume` 命令两条入口）
- 提问模型从单题 `title/options` 升级为 `questions[]` 批量问题模型，支持把不同语义维度拆成独立问题
- 选项从平铺 `string[]` 升级为结构化 `QuestionOption[]`（含 `label`、`description`）
- 支持单次 `ask_user_question` 调用携带多个独立问题
- 多选从工具 Schema 到 CLI 渲染到 Session 恢复的全链路贯通
- 答案模型从 `string` 升级为 `Record<string, string | string[]>`
- CLI 提问渲染收敛到 `@clack/prompts`，消除手写 `readline` 分支

**非目标：**
- 不引入批量问题分页导航 UI（像 Claude Code 的 Q1/Q2/Q3/Submit 导航栏）
- 不引入选项 `preview` 字段（HTML/Markdown 预览）
- 不引入多通道审批竞速（Bridge、渠道、Hook 等并行审批路径）
- 不引入自动超时兜底（`auto_resolution_ms`）
- 不引入密码掩码输入（`isSecret`）
- 不以兼容旧版 `title/options` ask 载荷和旧版 `pendingInteraction` 快照为本次 change 的目标

## 架构决策

### 决策 1：本次 change 只修改既有 `ask-user-question` 能力

**现状**：当前 change 新增了 `structured-ask` 和 `ask-lifecycle-protection` 两个 spec，但真实要修的是既有 `ask-user-question` 能力本身。

**选型**：将结构化选项、多问题、多选、CLI 幂等恢复全部收敛到现有 `ask-user-question` 的 MODIFIED requirements 中；`interactive-tool-lifecycle` 只保留原有“人机中断工具无默认超时”的职责，不再为 ask 的具体交互形态额外分叉新能力。

**理由**：
- 这次问题边界仍是一个能力：agent 向用户提问并恢复执行
- CLI 防重与快照恢复治理，都是 ask 交互契约的一部分，不是一个独立业务域
- 避免后续出现“全局 ask spec 一份、structured-ask 又一份”的平行漂移

### 决策 2：提问模型升级为批量问题 + 显式模式契约

**现状**：`AskUserPayload` 是平的 `{title, options?, multiSelect?, allowFreeInput?}`，单次只支持一个问题，而且多个布尔字段组合会持续制造歧义。

**选型**：参考 OpenCode、Codex、Claude Code 的公共趋势，统一升级为：

```typescript
export interface QuestionOption {
  label: string;
  description?: string;
}

export type QuestionMode =
  | 'single-select'
  | 'multi-select'
  | 'free-text'
  | 'single-select-or-text';

export interface UserQuestion {
  id: string;
  header: string;
  question: string;
  mode: QuestionMode;
  options?: QuestionOption[];
}

export interface AskUserPayload {
  questions: UserQuestion[];
}
```

**理由**：
- `questions[]` 模式让不同语义维度的问题自然拆开，不再混在一个题里
- `QuestionOption` 的结构化字段让 CLI 可渲染 label + description 双层展示
- `mode` 避免 `multiSelect + allowFreeInput + options` 这类布尔组合持续制造非法搭配
- `single-select-or-text` 直接覆盖当前“选项 + Other 自定义输入”的真实需求

**否决**：
- ~~保留 `options: string[]` 并在 CLI 层加逗号分隔解析~~ —— 答案模型仍然是单 `string`，挂起恢复和快照持久化继续失真
- ~~继续沿用 `multiSelect` / `allowFreeInput` 布尔组合~~ —— 这正是当前契约含混的根源，不应在新 change 中继续放大

### 决策 3：答案模型升级为按问题索引的结构化映射

**现状**：`InteractionPort.askUser()` 返回 `Promise<string>`，`PendingInteraction.answer` 是 `string`。

**选型**：升级为按问题 id 索引的结构化映射：

```typescript
// 新的答案模型
export type QuestionAnswer = string | string[];  // 单选为 string，多选为 string[]

export interface AskUserAnswer {
  [questionId: string]: QuestionAnswer;
}
```

**理由**：
- 多问题场景下每个问题独立回答，按 id 索引天然适合
- 多选答案用 `string[]` 承载，语义直接
- 单问题场景下仍然只是一个键，不额外增加使用复杂度
- 用户取消或外部 abort 时可用空对象 `{}` 表达“无答案”，避免伪造字符串占位

**影响链路**：
- `InteractionPort.askUser()` 签名：`Promise<string>` → `Promise<AskUserAnswer>`
- `PendingInteraction.answer` 类型：`string` → `AskUserAnswer`
- `SessionManager.resumePendingInteraction()` 入参：`string` → `AskUserAnswer`
- `SessionManager` 写回 tool 消息时改为结构保持的 JSON 文本
- `ContextRepository` 快照中的 `pendingInteraction` 序列化格式升级

### 决策 4：CLI 防重保护放在 `CliFacade.handlePendingInteraction`

**现状**：`handlePendingInteraction` 无去重保护。

**选型**：在 `CliFacade` 中维护 `activeInteractionIds: Set<string>`：

```typescript
// CliFacade 新增
private activeInteractionIds = new Set<string>();

private async handlePendingInteraction(interaction: PendingInteraction): Promise<void> {
  if (this.activeInteractionIds.has(interaction.id)) return;  // 幂等
  this.activeInteractionIds.add(interaction.id);
  try {
    // ... 原有逻辑
  } finally {
    this.activeInteractionIds.delete(interaction.id);
  }
}
```

**理由**：
- `Set<string>` 是最轻量的去重方案，无外部依赖
- 只有进入 `try` 块才算成功持有，`finally` 保证无论成功还是异常都释放
- 同时覆盖 `interaction_request` 事件和 `/resume` 命令两条入口（都走 `handlePendingInteraction`）

### 决策 5：快照恢复沿用现有 pending-only 过滤，不重复设计无效判定

**现状**：`SessionContext.restorePendingInteraction()` 虽然只是赋值，但 `ContextRepository.normalizePendingInteraction()` 已经只会恢复 `state === 'pending'` 的交互。

**选型**：不再额外添加一层重复的 `state` 判断；本次只更新 `normalizePendingInteraction()` 以识别新的 ask 载荷格式，并把“恢复后只允许拉起一次 UI”的责任放回 `CliFacade` 的幂等保护。

**理由**：
- 已完成交互不重放这一点，现有仓储层已经成立
- 真正缺失的是“同一 pending 交互被多入口重复渲染”的运行态保护，而不是再补一个重复判定
- 这样可以避免设计文档与现有实现事实相冲突

### 决策 6：CLI 渲染统一收敛到 `@clack/prompts`

**现状**：`InteractionHandler.renderAndWait` 使用手写 `readline` 打印编号 + 读取序号。

**选型**：使用 `@clack/prompts` 的 `select`（单选）、`multiselect`（多选）和 `text`（自由输入）组件替代手写逻辑：

```typescript
import * as clack from '@clack/prompts';

// 单选
const answer = await clack.select({
  message: question.question,
  options: question.options?.map((o) => ({
    label: o.label,
    value: o.label,
    hint: o.description,
  })) ?? [],
});

// 多选
const answers = await clack.multiselect({
  message: question.question,
  options: question.options?.map((o) => ({
    label: o.label,
    value: o.label,
    hint: o.description,
  })) ?? [],
  required: false,
});
```

**理由**：
- 仓库已有 `@clack/prompts` 依赖，有 `selectWithCleanCancel` 等自定义适配层可复用
- 消除手写 `readline` 分支，取消语义、提示 footer、stdin 独占规则统一
- `@clack/prompts` 原生支持单选 / 多选 / 文本输入，无需自行实现
- 多问题场景可直接顺序渲染，每题单独复用最合适的交互控件

**否决**：
- ~~继续在 `renderAndWait` 中扩展手写 `readline` 支持多选~~ —— 两套交互栈并行演化成本高，且 `@clack/prompts` 已覆盖交互需求
- ~~采用 Ink/React 渲染~~ —— 过于重量级，不适合 CLI-only 场景

## 风险与权衡

| 风险 | 缓解策略 |
|------|---------|
| `InteractionPort.askUser()` 签名变更为 BREAKING change，若有外部调用者需要同步更新 | 先行确认端口所有使用方，避免漏改 |
| 旧版 ask 快照不再兼容，可能导致历史 pending 交互被安全丢弃 | 明确将其视为本次 change 的已知取舍，不再为旧格式增加过渡协议 |
| `@clack/prompts` 的 stdin 独占行为与 InputListener 冲突 | 复用已有的 `selectWithCleanCancel` 中的 stdin 适配逻辑 |
| 多选答案的空选择如何处理（用户一个都不选） | 明确约定返回 `[]`，而不是空字符串或缺失字段 |

## 开放问题

- `single-select-or-text` 是否已经足够覆盖混合场景，还是未来需要独立的 `multi-select-or-text` 模式？本次建议先不扩张
