## MODIFIED Requirements

### Requirement: 工具去中心化配额差异化折叠 (Decentralized Tool Quota Pruning)

工具模块 MUST 在注册元数据中允许自定义 `maxLines` 和 `maxBytes`。当工具输出超过配额时，系统 MUST 将完整输出同步写入当前项目应用数据的 `artifacts/tool-outputs/`，并在消息历史中记录包含折叠预览与稳定文件引用的复合结构。模型可按需读取该引用，但读取权限 MUST 仅覆盖当前项目的 tool-output 目录，不得扩展到整个用户应用数据目录。

#### Scenario: 工具输出超出配额触发外带裁剪

- **WHEN** `search` 工具返回超过 100 行文本，且该工具声明 `maxLines` 为 50
- **THEN** 系统把完整内容写入当前项目 `artifacts/tool-outputs/`，消息历史保存可解析引用，发送给模型的预览只保留前 25 行和后 25 行

#### Scenario: 按引用分页读取完整输出

- **WHEN** 模型使用消息中的稳定引用请求读取当前项目某个完整工具输出
- **THEN** 系统解析引用并只读访问当前项目 `artifacts/tool-outputs/` 下的规范化目标文件，允许合法分页读取

#### Scenario: 工具输出引用尝试越界

- **WHEN** 引用包含路径穿越、符号链接逃逸，或指向 settings、session、browser state、其他项目数据
- **THEN** 系统拒绝读取且不返回目标内容，不能因为应用数据目录位于 workspace 外而授权整个 `~/.myagent`
