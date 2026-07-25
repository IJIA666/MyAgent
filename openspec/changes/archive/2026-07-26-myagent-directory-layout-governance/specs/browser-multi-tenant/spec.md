## MODIFIED Requirements

### Requirement: 浏览器 Profile 物理路径动态隔离

工具底座 MUST 依据传入的唯一租户或会话标识 `tenantId`，在当前 workspace 对应的项目应用数据 `state/browser/<tenant-id>/` 下动态生成并绑定独立的本地物理状态路径，从物理层面实现不同项目和不同租户之间 Cookies、LocalStorage 与锁文件的彻底隔离。

#### Scenario: 传入租户标识成功启动隔离浏览器上下文

- **WHEN** 智能体在携带租户 ID `tenant-abc` 的会话上下文中启动浏览器相关工具
- **THEN** Playwright 将 user-data-dir 指向当前项目解析出的 `state/browser/tenant-abc/` 并启动 Persistent Context，且不得访问其他项目或租户的浏览器状态

### Requirement: 租户 Profile 生命周期销毁与清理

工具底座 MUST 提供特定租户会话生命周期结束时的优雅关闭机制，并提供是否彻底清除该临时租户 Profile 目录的显式选项。清理 MUST 限定在当前项目应用数据的对应租户目录内。

#### Scenario: 会话退出时优雅关闭并安全擦除临时租户 Profile

- **WHEN** 租户 `tenant-temp` 会话退出或主动释放，且开启了临时 Profile 清除选项
- **THEN** 系统优雅关闭该租户的 `BrowserContext` 和 `Page`，释放锁，并只删除当前项目 `state/browser/tenant-temp/` 目录

#### Scenario: 无头模式转有头人机协作登录时强制释放旧无头实例

- **WHEN** 智能体在无头模式下检测到需要登录并触发 `browser_ensure_login` 协作干预
- **THEN** 工具底座 MUST 首先释放该租户当前的无头页面与上下文并解除物理锁，再拉起有头浏览器窗口供用户操作

#### Scenario: 人机协作确认后自动清理有头实例并重置为后台无头运行

- **WHEN** 智能体在无头模式下触发人机协作，用户在弹出窗口中完成操作并确认继续
- **THEN** 工具底座 MUST 立即优雅关闭协作拉起的有头页面与上下文，使后续网页操作重新使用同一租户状态目录以无头模式运行
