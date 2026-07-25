## MODIFIED Requirements

### Requirement: RuleManager watcher 必须与拥有者生命周期一致

`RuleManager` 必须（MUST）保存 watcher 句柄并提供幂等关闭方法；主会话结束时必须释放 timer、watcher 与候选事件状态。

#### Scenario: 主会话关闭

- **WHEN** `SessionManager.close()` 执行
- **THEN** 当前 RuleManager 必须关闭 watcher、清理 debounce timer，且关闭后不得再更新该会话的系统提示词

#### Scenario: 重复关闭

- **WHEN** 同一 RuleManager 被多次调用 close
- **THEN** 关闭必须幂等，不得抛错或重复操作已释放句柄
