## Purpose

定义文件局部编辑工具的匹配、修改和权限行为。该规范要求编辑请求在执行前验证目标和匹配条件，并与统一文件授权语义保持一致，避免模糊替换或越权修改。
## Requirements
### Requirement: 基于特征字符串的文件局部增量修改
系统 MUST 提供一个独立于全量写入的文件修改机制（例如 `editFile` 工具），通过接收精准的目标文件路径、原代码段（`old_string`）、新代码段（`new_string`）以及是否全局替换标志（`replace_all`，默认 false）来进行文件编辑。严禁在增量编辑时要求传入行号。

#### Scenario: 正常的唯一匹配替换
- **WHEN** 调用者请求替换某文本，文件中该 `old_string` 存在且仅有一处完全匹配，且 `replace_all` 为 false。
- **THEN** 系统应精确定位并将其替换为 `new_string`，保存文件并向调用者返回成功确认信息。

#### Scenario: 匹配失败（未找到目标字符串）
- **WHEN** 调用者请求替换，但目标文件中无法找到完全一致的 `old_string`。
- **THEN** 系统必须抛出明确的错误，说明“未找到待替换的原始字符串”，并建议调用者（如大模型）重新调用查阅工具确认文件的最新状态，或确认缩进空格等细节是否有误。

#### Scenario: 匹配不唯一且未开启全局替换
- **WHEN** 调用者请求替换，目标文件中存在 2 处或更多的 `old_string`，且 `replace_all` 显式或隐式为 false。
- **THEN** 系统必须进行安全拦截并抛出错误，提示“找到了多处匹配，无法确认要替换的准确位置。请提供包含更多前后文的 old_string 以确保唯一性，或者设置 replace_all 为 true”。

#### Scenario: 匹配多处且开启全局替换
- **WHEN** 调用者请求替换，目标文件中存在多处 `old_string`，且 `replace_all` 为 true。
- **THEN** 系统应将文件中所有的 `old_string` 全部批量替换为 `new_string`，并返回成功信息。

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
