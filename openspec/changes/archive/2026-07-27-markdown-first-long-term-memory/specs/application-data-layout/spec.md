## MODIFIED Requirements

### Requirement: 项目配置与应用运行数据必须分离

系统必须（MUST）仅在工作区 `.myagent/` 下保存可随项目共享或由用户明确维护的项目配置，包括 `settings.json`、`settings.local.json`、`rules/`、`skills/`。系统必须（MUST）将项目私有运行数据保存到 `~/.myagent/projects/<workspace-key>/` 下，并至少按 `logs/`、`state/`、`artifacts/`、`tmp/`、`memory/` 分类。长期记忆必须（MUST）通过 `ApplicationPaths.memoryDir` 指向当前项目的 `<projectDataDir>/memory/`，不得（MUST NOT）写入工作区 `.myagent/`。

#### Scenario: 正常启动项目

- **WHEN** 应用在工作区内启动并产生配置、日志、状态、产物、临时文件或长期记忆
- **THEN** 项目配置只写入工作区 `.myagent/` 的受支持配置集合
- **AND** 日志、状态、产物、临时文件和长期记忆分别写入当前项目私有数据目录下的对应分类

#### Scenario: 工作区内没有项目配置

- **WHEN** 工作区 `.myagent/` 不存在或缺少某个项目配置文件
- **THEN** 应用使用默认配置继续启动
- **AND** 不因为读取配置而创建无关运行数据目录

#### Scenario: 解析项目长期记忆目录

- **WHEN** `ApplicationPaths` 已根据当前工作区生成稳定的 `workspace-key`
- **THEN** `memoryDir` 等于 `<projectDataDir>/memory/`
- **AND** 该路径不位于工作区 `.myagent/` 中
