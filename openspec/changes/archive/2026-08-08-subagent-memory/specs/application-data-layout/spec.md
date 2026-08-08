## MODIFIED Requirements

### Requirement: 项目配置与应用运行数据必须分离

系统 MUST 使用 `.myagent` 作为唯一产品目录命名空间，并将人工维护的项目配置与程序生成的运行数据置于不同物理作用域。项目 `<workspace>/.myagent/` MUST 只包含 `settings.json`、`settings.local.json`、`rules/`、`skills/`、`agents/`（人工维护的子代理定义）和 `agent-memory/`（子代理项目域持久记忆，随版本控制共享的可提交配置数据，见 `subagent-memory`）；项目运行数据 MUST 位于 `~/.myagent/projects/<workspace-key>/` 下，并按 `logs/`、`state/`、`artifacts/`、`tmp/` 和 `memory/` 分类。长期记忆 MUST 通过 `ApplicationPaths.memoryDir` 指向当前项目的 `<projectDataDir>/memory/`，MUST NOT 写入工作区 `.myagent/`；子代理记忆 MUST 通过作用域解析：`project` 域位于 `<workspace>/.myagent/agent-memory/<type>/`（可提交），`local` 域位于 `<projectDataDir>/agent-memory-local/<type>/`（本机、项目隔离、不进入版本控制），`user` 域位于 `<userConfigDir>/agent-memory/<type>/`。

#### Scenario: 正常启动项目

- **WHEN** 用户从已授权 workspace 启动 MyAgent
- **THEN** 系统从 workspace `.myagent` 读取项目配置，并将该项目产生的日志、会话、浏览器状态、工具输出、截图和备份写入对应 workspace key 的用户应用数据目录

#### Scenario: workspace 内没有项目配置

- **WHEN** workspace 中不存在 `.myagent` 或其中不存在某个可选配置文件
- **THEN** 系统使用用户配置和内建默认值继续启动，且不得为了运行数据在 workspace 中创建 `.myagent`

#### Scenario: 解析项目长期记忆目录

- **WHEN** `ApplicationPaths` 已根据当前工作区生成稳定的 `workspace-key`
- **THEN** `memoryDir` 等于 `<projectDataDir>/memory/`
- **AND** 该路径不位于工作区 `.myagent/` 中

#### Scenario: 解析子代理项目域记忆目录

- **WHEN** 子代理定义声明 `memory: project`
- **THEN** 其记忆目录解析为 `<workspace>/.myagent/agent-memory/<type>/`
- **AND** 该目录作为可提交配置数据随版本控制共享

#### Scenario: 解析子代理 local 域记忆目录

- **WHEN** 子代理定义声明 `memory: local`
- **THEN** 其记忆目录解析为 `<projectDataDir>/agent-memory-local/<type>/`
- **AND** 该目录位于本机运行数据根内，不进入版本控制
