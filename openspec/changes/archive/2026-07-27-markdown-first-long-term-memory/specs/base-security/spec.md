## MODIFIED Requirements

### Requirement: 物理路径去模糊与防逃逸

系统必须（MUST）在授权和执行前解析现有父目录的真实路径，并验证高层文件 API 的目标位于授权工作区物理根或显式注入的当前项目 `ApplicationPaths.memoryDir` 物理根内。`memoryDir` 例外只能（MUST）授予标准高层文件 API，不得（MUST NOT）扩大到其父级 `projectDataDir`、其他项目目录或 terminal cwd。terminal cwd 必须（MUST）继续位于授权工作区物理根内。不存在的写入目标必须（MUST）通过最近现有父目录进行物理路径校验。

#### Scenario: 工作区内的正常文件访问

- **WHEN** 高层文件 API 的目标解析后位于授权工作区物理根内
- **THEN** 路径边界校验允许该目标继续进入权限判断和执行流程

#### Scenario: 标准文件工具访问当前项目 memoryDir

- **WHEN** 高层文件 API 的目标解析后位于显式注入的当前项目 `memoryDir` 物理根内
- **THEN** 路径边界校验允许该目标继续进入正常 effect、`PermissionMode` 和审计流程

#### Scenario: 访问 memoryDir 的相邻项目数据目录

- **WHEN** 高层文件 API 的目标位于当前项目 `projectDataDir` 下但不位于 `memoryDir` 内
- **THEN** 系统拒绝该访问

#### Scenario: 访问其他 workspace-key 的记忆目录

- **WHEN** 高层文件 API 的目标位于另一个项目的 `memoryDir`
- **THEN** 系统拒绝该访问

#### Scenario: 通过符号链接逃逸授权根

- **WHEN** 词法路径位于工作区或 `memoryDir` 内但真实路径解析到对应授权根之外
- **THEN** 系统拒绝该访问

#### Scenario: 不存在的写入目标通过父目录逃逸

- **WHEN** 写入目标尚不存在且其最近现有父目录的真实路径位于对应授权根之外
- **THEN** 系统拒绝该写入

#### Scenario: terminal cwd 指向 memoryDir

- **WHEN** terminal cwd 位于工作区外的当前项目 `memoryDir`
- **THEN** 系统拒绝该 cwd
