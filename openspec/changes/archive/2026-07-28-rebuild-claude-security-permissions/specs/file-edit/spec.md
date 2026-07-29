## ADDED Requirements

### Requirement: Real File Tools Declare Edit Semantics

`writeFile`、`editFile`、`applyPatch` 和 `createDirectory` MUST 通过各自 ToolCatalog 权限适配器声明真实参数、稳定权限身份和普通 Edit 分类。`deletePath`、`movePath`、`copyPath` MUST 保持独立高风险分类。

#### Scenario: Accept edits handles real camelCase tools

- **WHEN** 当前模式为 Accept edits on，目标位于允许编辑的普通工作区，模型调用 `writeFile`、`editFile`、`applyPatch` 或 `createDirectory`
- **THEN** 系统 MUST 自动允许
- **THEN** 系统 MUST NOT 因运行时名称不是 `Write`、`Edit`、`ApplyPatch` 或 `Create` 而重新询问

#### Scenario: A destructive file operation is requested

- **WHEN** 当前模式为 Accept edits on，模型调用 `deletePath`、`movePath` 或其他被适配器分类为破坏性的文件操作
- **THEN** 系统 MUST 按该工具专属策略询问或拒绝
- **THEN** 普通 Edit 模式 MUST NOT 自动放行

### Requirement: File Edit Approval Offers a Session Mode Transition

Manual 模式下的普通文件编辑审批 MUST 提供 Allow once、Allow and turn on Accept edits for this session、Deny。第二项 MUST 使用 `setMode(acceptEdits, session)`，不得通过宽泛路径规则模拟模式。

#### Scenario: The user turns on Accept edits

- **WHEN** Manual 模式下首次普通文件编辑产生 ask，用户选择本会话开启 Accept edits on
- **THEN** 当前调用 MUST 获批
- **THEN** 当前会话 MUST 切换到 `acceptEdits`
- **THEN** 后续普通 Edit 调用 MUST 不再询问

#### Scenario: The user allows once

- **WHEN** 用户选择 Allow once
- **THEN** 当前调用 MUST 获得一次性 grant
- **THEN** 后续相同编辑 MUST 再次按 Manual 评估

### Requirement: Protected and External Paths Remain Constrained

Accept edits on MUST NOT 覆盖 protected-resource policy 或未经批准的范围外目录。文件审批 UI MAY 复用同一组件，但 MUST 明确显示新增目录范围与将应用的动作。

#### Scenario: An edit targets a protected file

- **WHEN** Accept edits on 模式下编辑 `.env`、`.git`、MyAgent settings、rules、hooks 或 IDE 自动执行配置
- **THEN** 系统 MUST 询问或拒绝

#### Scenario: An edit targets an additional directory

- **WHEN** Manual 模式下编辑工作区外文件，用户只选择 Allow once
- **THEN** 当前调用 MAY 执行
- **THEN** 该目录 MUST NOT 被加入 session additional directories
- **THEN** 当前模式 MUST NOT 改变
