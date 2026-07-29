## Purpose

定义工具别名与正式 ToolCatalog descriptor 之间的稳定映射。该规范确保别名、重命名和兼容输入不会绕过相同的授权适配器、规则身份、物理路径校验或受保护资源策略。

## Requirements

### Requirement: 工具别名与安全拦截一致性
为了防范大小写拼写错误或工具重命名引起的安全卡关失效，工具常量契约体系必须(MUST)在重构后完整继承全部原有的别名校验能力，且安全卡关机制应当(SHALL)无感过渡。

#### Scenario: 终端命令工具别名匹配
- **WHEN** 智能体试图调用 "execute_command"、"bash"、"run_command"、"sh" 或 "executeCommandTool" 时
- **THEN** ToolCatalog 必须将别名解析到同一终端 descriptor，并使用同一 Shell ToolAuthorizationAdapter、规则身份和受保护资源策略。

#### Scenario: 文件读取与列举工具别名匹配
- **WHEN** 智能体试图调用 "readFile"、"listFiles"、"read_file" 或 "list_files" 时
- **THEN** ToolCatalog 必须将别名解析到对应只读 descriptor，并让统一权限网关执行相同的物理路径与授权根校验。

#### Scenario: 文件修改与写入工具别名匹配
- **WHEN** 智能体试图调用 "writeFile"、"editFile"、"write_file" 或 "edit_file" 时
- **THEN** ToolCatalog 必须将别名解析到对应文件 descriptor，并让统一权限网关使用同一 File ToolAuthorizationAdapter、模式和受保护路径策略。
