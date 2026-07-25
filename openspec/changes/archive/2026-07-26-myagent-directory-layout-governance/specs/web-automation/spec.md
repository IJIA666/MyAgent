## MODIFIED Requirements

### Requirement: CDP 直连与本地 Profile 双通道会话共享

工具 MUST 支持 CDP 远程调试直连和本地 Profile 持久化两种通道。指定 `cdpUrl` 时 MUST 直连对应端口；未指定时 MUST 使用当前 workspace 对应项目应用数据的 `state/browser/<tenant-id>/`。显式浏览器数据目录覆盖仍可使用，但 MUST 在配置边界解析后传入浏览器模块。

#### Scenario: 通过 CDP 端口共享隔离调试浏览器状态

- **WHEN** 智能体传入 `cdpUrl` 实例化页面
- **THEN** 工具通过 `connectOverCDP` 连接指定端口，不创建默认项目 Profile

#### Scenario: 通过项目应用数据 Profile 持久化会话

- **WHEN** 智能体未配置 `cdpUrl` 且未提供显式外部 Profile 覆盖
- **THEN** 工具通过 `launchPersistentContext` 使用当前项目与租户对应的 `state/browser/<tenant-id>/`，后续启动可复用该租户登录状态

#### Scenario: 显式外部 Profile 覆盖

- **WHEN** 用户通过受支持配置提供外部浏览器数据目录
- **THEN** 浏览器使用已解析的显式目录，并在状态与诊断信息中显示实际生效路径，不再从 `process.cwd()` 推导默认路径
