# 探索主题: 消除模型提前拒绝 — System Prompt 与工具描述调整

## 1. 问题定义

**问题 A**：Agent 推理层遇越界操作提前拒绝，不触发工具层审批。

用户在实测中发现，要求 Agent 清理 C 盘时，Agent **没有触发工具审批流程**就在回答中给出了理论方案。

## 2. 根因分析

### 2.1 高概率诱因：System Prompt 措辞

`RULE_FILE_SANDBOX`（`prompts.ts:11`）的措辞：

```
所有文件操作都必须严格限制在授权的工作区目录下。
你的工具集会自动执行此项校验，一旦你尝试越权操作外部目录，
工具将返回拒绝访问 of 错误。
```

后半段"一旦你尝试越权操作外部目录，工具将返回拒绝访问"是一种负面预判，可能导致模型提前放弃。但非唯一原因：文件工具的 `description` 也反复强调"授权工作区"，多信息来源叠加可能强化模型的自我审查。

### 2.2 跨项目参考

| 项目 | 越界相关 prompt | 源码引用 |
|:---|:---|:---|
| Claude Code | 未在公开 prompt 中找到类似"越界会拒绝"的措辞，权限由工具层处理 | `src/utils/permissions/filesystem.ts` |
| OpenCode | Gemini 模板（`gemini.txt:49`）告知模型宿主会展示确认对话框，无需自行询问；Copilot-GPT-5 模板措辞不同（`copilot-gpt-5.txt:119`） | `packages/opencode/src/session/prompt/` |
| Hermes Agent | 无类似措辞，安全检查在 approval.py 的 guard 函数中 | `tools/approval.py` |
| OpenClaw | 无，策略层管理 | `src/agents/tool-policy.ts` |

两者都不在 prompt 中使用负面预判措辞。

### 2.3 前置依赖

此修改的效果依赖于审批执行链路的完整性（`approval-capability-lifecycle` change）。在审批后的白名单传递断裂未修复前，Agent 即使调用工具并获批，越界操作仍可能在 `execute()` 阶段失败。

## 3. 推荐方案

### 3.1 System Prompt 修改

将 `RULE_FILE_SANDBOX` 的负面预判措辞替换为中性描述：

> 不要仅因目标位于工作区外而提前拒绝用户请求。应调用合适工具，由工具层依据安全策略执行、请求审批或拒绝。

不承诺越界一定会触发审批，只是消除"尝试即错误"的预判。

### 3.2 工具 description 调整

工具 description 仍应告知默认边界，调整措辞避免强化自我审查：

> 默认在工作区内操作；外部路径由工具层依据安全策略审批或拒绝。

不完全移除边界描述（防止模型误以为工具无限制），但移除"你的工具集会拒绝"等执行结果预判。

改动范围：`ReadFileTool`、`WriteFileTool`、`EditFileTool`、`ListFilesTool`、`DeletePathTool` 等工具的 `definition.function.description`。

## 4. 实施约束

- 依赖 `approval-capability-lifecycle` change 完成（审批执行链路完整）。
- 需要分别验证终端命令和文件工具路径：终端命令走 `terminal-guard.ts` 审批路径，文件工具走 `secureResolveWritePath` 路径，两者行为不同。
- 修改后需实测 Agent 是否真的会尝试调用越界工具，而非继续在推理层放弃。

## 5. 风险

- 过度移除边界描述可能导致模型误以为工具无全盘访问能力——措辞保留"默认在工作区内"。
- 不同模型对 prompt 措辞的敏感性不同，需要实际测试。
- 此修改不能独立修复问题 A，必须与 `approval-capability-lifecycle` 和 `approval-policy-contract` 协同。

## 6. 否决方案

- **Agent 不需要知道边界存在**：错误抽象。参考 OpenCode，模型可以知道宿主会处理审批，但不能自行拒绝。
- **仅改 prompt 一行就声称修复**：不成立，审批执行链是前置阻塞问题。
- **在审批安全契约重构 change 中同步修改 prompt**：行为回归难以定位。应单独作为一个独立 change。
