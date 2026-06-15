## ADDED Requirements

### Requirement: 基于特征字符串的文件局部增量修改
系统必须提供一个独立于全量写入的文件修改机制（例如 `editFile` 工具），通过接收精准的目标文件路径、原代码段（`old_string`）、新代码段（`new_string`）以及是否全局替换标志（`replace_all`，默认 false）来进行文件编辑。严禁在增量编辑时要求传入行号。

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
