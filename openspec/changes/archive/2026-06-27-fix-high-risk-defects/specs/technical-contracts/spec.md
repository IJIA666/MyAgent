## 新增需求

### 需求: 规则与技能加载的多会话工作区物理隔离
系统在运行时，针对不同的会话实例（SessionContext），其规则与技能的扫描、加载及缓存必须（MUST）保持完全独立的实例级别隔离，绝不允许（SHALL NOT）共享全局模块状态，以防止并发多工作区下的技能交叉污染。

#### 场景: 并发加载不同工作区技能
- **WHEN** 两个不同的会话 Session A 和 Session B 拥有不同的 `appConfig.workspace` 物理路径，并分别触发其规则与技能的初始化加载。
- **THEN** Session A 只能且必须（MUST）加载并执行 A 工作区内的技能列表；Session B 只能且必须加载并执行 B 工作区内的技能列表，两者的缓存与调用必须完全物理隔离，互不冲突。

---

### 需求: 系统通知同步合并落盘
在会话执行过程中产生的系统通知消息，在 Hooks 执行期必须（MUST）先在暂存队列中积压。在当前交互 Loop 结束的确定同步上下文中，系统必须同步且强制地将它们刷入历史栈中并执行持久化保存，绝对不允许（SHALL NOT）在异步微任务或 `process.nextTick` 回调中执行可能被 Immer 脏写覆盖的操作。

#### 场景: 多 Hook 连续执行期间收到后台系统通知
- **WHEN** 在 `BeforeToolSelection` 钩子处理结束且进入下一个 Hook `BeforeModel` 之间，有外部异步模块发出并追加了新的系统通知。
- **THEN** 该通知会被安全暂存至 `pendingNotifications` 队列中；在整个 `AgentLoop` 结束或 `SessionEnd` 后，系统同步且强制执行 `flushPendingNotifications`，将队列中的所有通知一次性同步追加至历史中并执行 `saveState()`，确保通知 100% 递达且绝不发生消息覆盖。

---

### 需求: 大模型消息历史流 Spec 契约合规
上下文适配器在装配发送给大模型的历史消息时，必须（MUST）确保 `system`/`developer` 消息仅位于序列第一位，后续的消息流必须呈现 `user` 与 `assistant` 交替的形式，绝不允许（SHALL NOT）将 `system` 消息插入在非首位的历史流中。

#### 场景: recentFiles 存在时的请求装配
- **WHEN** 上下文装配器 `DefaultContextAdapter` 检测到 `recentFiles` 集合存在并需要注入历史。
- **THEN** 系统必须将最近文件索引数据（格式化为 `<recent_files_inventory>` XML）物理追加合并到第一条 `user` 角色消息（Checkpoint 消息）的 `content` 末尾，而不是作为一个独立的 `system` 角色消息插在历史流的中部。
