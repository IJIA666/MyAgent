## 修改需求

### 需求: execute_command 工具新增可选 shellKind 参数

系统必须（MUST）在 `execute_command` 工具的 JSON Schema 参数定义中新增可选的 `shellKind` 字段。其取值为 `auto | posix | powershell | cmd` 字符串枚举，默认值为 `auto`。该变更必须保持接口兼容：现有调用方无需修改即可继续调用该工具；当模型未传入此参数时，系统按 `auto` 的既定分辨率决议 shell family。

原需求定义位于 `terminal-tool` 的 `execute_command` 工具声明部分，此处为增量修改：在 `parameters.properties` 中追加 `shellKind` 字段。

#### 场景: 模型显式指定 shellKind
- **WHEN** 模型调用 `execute_command` 时传入 `shellKind: "posix"` 及命令 `ls -la`
- **THEN** 系统使用 POSIX shell 语义执行命令，安全网关按 POSIX 规则进行命令解析与安全校验

#### 场景: 模型未指定 shellKind（向后兼容）
- **WHEN** 模型调用 `execute_command` 时未传入 `shellKind` 参数
- **THEN** 系统使用 `auto` 默认值进行 shell family 分辨率，且工具接口对现有调用方保持兼容；是否与改造前的具体平台执行语义完全一致，由 `auto` 的平台默认策略决定并在设计中单独说明

#### 场景: 显式指定不受支持的 shellKind
- **WHEN** 模型调用 `execute_command` 时显式传入 `shellKind: "powershell"`，但当前环境不支持 PowerShell
- **THEN** 工具返回清晰的 shell 不受支持错误，且不得静默改用其他 shell 执行该命令
