## 修改需求

### 需求: 会话级授权令牌（session capability）
系统必须（MUST）提供会话级（session-level）的授权机制，使用户选择的"始终放行"将规范化资源按访问类型（read/write）分别写入会话临时白名单。

#### 场景: always 决策写入会话白名单
- **WHEN** `AgentLoop` 条件满足后提交 `session` 类型的 `pendingGrant`
- **THEN** 系统必须（MUST）遍历所有路径资源，按 `access`（`read`/`write`）分别调用 `addTemporaryReadWhitelist` 或 `addTemporaryWriteWhitelist`。读授权和写授权严格隔离，不可交叉

#### 场景: session grant 跨多次调用生效
- **WHEN** 同一会话中，工具再次操作已授权到会话白名单的路径
- **THEN** 系统必须（MUST）在 `checkSafety()` 阶段通过 `secureResolve{Read,Write}Path(path, sessionContext)` 识别到已有 session grant，返回 `status: 'pass'`，跳过审批弹窗

#### 场景: 会话白名单在会话关闭时自动清除
- **WHEN** `SessionManager.close()` 被调用，进入 `SessionClosed` 生命周期阶段
- **THEN** 系统必须（MUST）在该阶段自动销毁该会话对应的所有临时白名单（读/写/目录范围）
- **AND** 单次 `chat/run` 结束或迭代结束不得触发白名单清理

---

## 新增需求

### 需求: session 白名单不得在单次 run 结束时被清空

系统必须（MUST）确保 `AgentLoop.chat()` 的内部迭代 `finally` 收尾路径以及单次 run 结束时的 `RunEnd` Hook 管道中都不包含任何 `clearTemporaryWhitelists()` 调用，消除旧行为中"每次迭代结束清空全部会话白名单"的 bug。

#### 场景: 迭代结束后 session 白名单保持有效
- **WHEN** `AgentLoop.chat()` 的 while 循环完成一次迭代（包括所有工具调用和 LLM 推理），进入内部 finally 收尾
- **THEN** 系统不得调用 `SessionContext.clearTemporaryWhitelists()` 或 `SecurityService.clearTemporaryWhitelists()`
- **AND** 该次迭代中用户授予的所有 session 级授权白名单条目保持完整

#### 场景: 同一次 run 内多轮迭代的 session 授权持续生效
- **GIVEN** 当前 `chat/run` 的第一次迭代中，用户对路径 `/foo` 选择了"会话始终放行"
- **WHEN** 同一 `chat/run` 的第三次迭代再次操作路径 `/foo`
- **THEN** session 白名单必须命中，审批自动跳过
