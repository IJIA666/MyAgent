## ADDED Requirements

### Requirement: 目录浏览型只读资源必须显式声明为目录范围资源

系统必须支持一种显式的目录范围只读资源类型，用于表达"允许读取某目录及其子树"，并与普通精确路径资源区分。

#### Scenario: 目录浏览工具上报 directory-scope 资源

- **WHEN** `ListFilesTool.checkSafety()` 检测到目标目录越界
- **THEN** 上报的资源必须包含 `kind: 'directory-scope'`
- **AND** 资源必须包含 `access: 'read'`
- **AND** 资源必须携带 `normalizedPath`

#### Scenario: 单文件读取仍上报普通 path 资源

- **WHEN** `ReadFileTool.checkSafety()` 检测到目标文件越界
- **THEN** 上报的资源必须使用 `kind: 'path'`
- **AND** 该资源仅表示精确路径授权

#### Scenario: 会话授权载荷不得丢失目录范围语义

- **WHEN** 用户对 `directory-scope` 资源选择 `session`
- **THEN** 授权载荷必须保留该资源的 `kind`
- **AND** 后续授权落库逻辑必须能够区分精确路径读与目录范围读

### Requirement: 目录范围读授权必须对子树生效，但不得扩展到兄弟目录或写权限

系统必须在读权限检查时支持"命中任一祖先目录范围授权即通过"，同时严格限制在该目录树内，并且不得影响写权限判定。

#### Scenario: 目录浏览放行后子目录自动放行

- **WHEN** 用户批准了 `listFiles("C:\\Projects")` 的 `session`
- **THEN** `C:\\Projects` 必须被记录为目录范围读授权根
- **AND** Agent 在当前会话中访问 `C:\\Projects\\sub`
- **THEN** 不得再次触发新的读审批

#### Scenario: 兄弟目录不应被放行

- **GIVEN** 当前会话已批准目录范围读资源 `C:\\Projects\\a`
- **WHEN** Agent 访问 `C:\\Projects\\b`
- **THEN** 系统必须视为未命中目录范围授权

#### Scenario: readFile 的精确授权不得被放大

- **WHEN** 用户批准了 `readFile("C:\\Projects\\a.txt")` 的 `session`
- **THEN** `C:\\Projects\\other.txt` 不得因该授权自动放行

#### Scenario: 目录范围读可复用到子树内文件读取

- **GIVEN** 当前会话已批准目录范围读资源 `C:\\Projects`
- **WHEN** Agent 读取 `C:\\Projects\\sub\\a.txt`
- **THEN** 读权限检查必须通过

#### Scenario: 写权限不继承目录范围读授权

- **GIVEN** 当前会话已批准目录范围读资源 `C:\\Projects`
- **WHEN** Agent 写入 `C:\\Projects\\sub\\a.txt`
- **THEN** 写权限检查仍必须走独立写授权

### Requirement: 目录范围判定必须基于真实物理路径

系统必须基于 `getPhysicalRealPath()` 解析后的真实物理路径判定目录范围关系，不得做简单的字符串前缀比较。具体实现采用 `relative()` 计算相对路径后判定目标是否在授权根目录树内。

#### Scenario: 字符串前缀相似但不在同一子树

- **GIVEN** 已批准目录范围读资源 `C:\\Projects\\a`
- **WHEN** Agent 访问 `C:\\Projects\\a2`
- **THEN** 系统必须视为未命中目录范围授权

#### Scenario: 符号链接不跨越安全边界

- **GIVEN** 目录范围授权根为 `C:\\Projects`
- **AND** `C:\\Projects\\link` 是一个指向 `D:\\Outside` 的符号链接
- **WHEN** Agent 访问 `C:\\Projects\\link\\file.txt`
- **THEN** 系统应当拒绝该访问，因为其真实物理路径不在授权根内

### Requirement: 审批提示必须明确告知目录范围

审批 UI 必须在用户选择 `session` 或 `always` 时，清晰标明授权覆盖范围。

#### Scenario: 目录范围读提示文案

- **WHEN** 审批 UI 渲染 `directory-scope` 资源
- **THEN** 文案必须明确表达"允许读取该目录及其所有子目录"或同等含义
- **AND** 不得误导为写权限或全盘文件系统授权

#### Scenario: 普通路径读提示文案保持原语义

- **WHEN** 审批 UI 渲染普通 `path` 读资源
- **THEN** 文案必须保持"允许读取某具体路径"的精确语义

### Requirement: 本 change 仅覆盖 listFiles 的目录浏览语义

系统必须将本次目录范围授权能力限定在 `listFiles` 对应的目录浏览场景，不得在没有单独设计与验证的前提下自动扩展到其他搜索类工具。

#### Scenario: grepSearch 不因本 change 自动获得目录范围语义

- **WHEN** 系统处理 `grepSearch` 的资源声明与授权
- **THEN** 行为必须保持现状

#### Scenario: globSearch 不因本 change 自动获得目录范围语义

- **WHEN** 系统处理 `globSearch` 的资源声明与授权
- **THEN** 行为必须保持现状
