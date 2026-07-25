## 新增需求

### Requirement: 浏览器 Profile 物理路径动态隔离
工具底座必须（MUST）支持依据传入的唯一租户或会话标识（`tenantId`），在对应项目应用数据的 `state/browser/<tenant-id>/` 下动态生成并绑定独立的本地物理状态路径，从物理层面实现不同会话间 Cookies、LocalStorage 和文件锁定文件的彻底隔离。

#### Scenario: 传入租户标识成功启动隔离浏览器上下文
- **WHEN** 智能体在携带有租户 ID `tenant-abc` 的会话上下文中尝试启动浏览器相关工具。
- **THEN** 智能体底层 Playwright 自动将 user-data-dir 指向当前项目解析出的 `state/browser/tenant-abc/` 并启动 Persistent Context，物理隔离其它租户的会话状态及SingletonLock。

### Requirement: 多会话实例路由与并发复用
当多个租户/账号并发操作浏览器时，智能体底层管理服务必须（MUST）能够根据当前的租户 ID 准确路由到对应的 `BrowserContext` 与 `Page` 实例，严禁多个并发租户之间因共用同一浏览器页面导致交互事件穿透或覆盖。

#### Scenario: 多个不同租户并行执行时各占独立 Page 实例
- **WHEN** 租户 `tenant-abc` 与租户 `tenant-xyz` 先后在独立的会话中发起网页导航或控制交互。
- **THEN** 智能体底层分别为其路由并分发至各自独立的 Page 和 Context 对象进行控制，互不产生任何串扰或操作污染。

### Requirement: 租户 Profile 生命周期销毁与清理
工具底座必须（MUST）提供特定租户会话生命周期结束时的优雅关闭机制，并提供是否彻底清除该临时租户本地 Profile 缓存目录的自适应选项，防止因大量临时运行产生磁盘冗余。

#### Scenario: 会话退出时优雅关闭并安全擦除临时租户 Profile
- **WHEN** 租户 `tenant-temp` 会话退出或主动触发实例释放，且开启了临时缓存清除选项。
- **THEN** 智能体底层优雅释放并关闭属于该租户的 `BrowserContext` 及 `Page` 实例，释放所有的 SingletonLock 锁，并只删除当前项目 `state/browser/tenant-temp/` 目录。

#### Scenario: 无头模式转有头人机协作登录时强制释放旧无头实例
- **WHEN** 智能体在无头模式下检测到需要登录并触发 `browser_ensure_login` 协作干预。
- **THEN** 工具底座必须（MUST）首先释放该租户当前的无头浏览器页面与上下文，解开物理锁，再拉起并弹出有头浏览器窗口供用户操作。

#### Scenario: 人机协作确认后自动清理有头实例并重置为后台无头运行
- **WHEN** 智能体在无头模式（`BROWSER_HEADLESS !== 'false'`）下触发人机风控协作，用户在弹出的 GUI 窗口中手动处理完毕并在终端确认继续。
- **THEN** 智能体底座在恢复环境变量后，必须（MUST）立即优雅关闭协作拉起的有头 `Page` 和 `BrowserContext` 实例并清理其缓存占用，以迫使后续网页操作能够重新以无头（headless）模式在后台静默运行。
