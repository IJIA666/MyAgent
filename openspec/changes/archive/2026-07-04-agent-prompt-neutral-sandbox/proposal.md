## 改造原因

实测发现，当用户要求 Agent 执行工作区外的文件操作时，模型可能在推理层先自我拒绝，未进入工具层的安全审批链。根因集中在两类文案：

1. `RULE_FILE_SANDBOX` 直接预判了“越权尝试会返回拒绝访问错误”，容易把“存在边界”误导成“禁止尝试”。
2. 多个文件系统工具与终端工具的 `description` 重复使用“授权工作区”“受限的工作区沙箱”“禁止读写工作区外部路径”等措辞，持续强化模型的自我审查倾向。

在 `approval-capability-lifecycle` 与 `approval-policy-contract` 已落地后，当前已经具备安全策略与审批链路，本 change 可以安全地把这些文案改为“默认边界 + 工具层裁决”的中性表述。

## 变更内容

1. 将 `RULE_FILE_SANDBOX` 从结果预判改为中性委托语义，明确要求模型不要仅因目标路径位于工作区外就提前拒绝，而应正常调用工具，由工具层依据安全策略执行、请求审批或拒绝。
2. 调整文件系统工具与终端工具的 `description`，保留默认工作区边界，但去除“越界即失败”的否定预判措辞。
3. 增加针对 prompt 与工具定义文案的单元测试，防止后续回退。

无 BREAKING 变更。

## 业务能力

### 修改业务能力

- `prompt-refactor-structure`: `RULE_FILE_SANDBOX` 的行为语义从“负面预判”改为“中性委托”，要求 Agent 遇到工作区外路径时优先交由工具层裁决，而不是在推理层直接放弃。

## 影响范围

- `src/core/usecases/brain/prompts.ts` - `RULE_FILE_SANDBOX`
- `src/adapters/tools/impl/filesystem/file-system.ts` - ReadFile、WriteFile、EditFile、ListFiles 的 `description`
- `src/adapters/tools/impl/filesystem/directory-manager.ts` - CreateDirectory、DeletePath 的 `description`
- `src/adapters/tools/impl/filesystem/search.ts` - GrepSearch、GlobSearch 的 `description`
- `src/adapters/tools/impl/filesystem/read-many-files.ts` - ReadManyFiles 的 `description`
- `src/adapters/tools/impl/system/terminal.ts` - ExecuteCommand 的 `description`
- `test/core/usecases/brain/prompt.test.ts` - `RULE_FILE_SANDBOX` 文案回归测试
- `test/adapters/tools/tool-definition-description.test.ts` - 工具描述中性边界回归测试
