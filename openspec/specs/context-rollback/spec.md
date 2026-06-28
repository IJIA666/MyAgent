# Capability: context-rollback

## Purpose
提供 Agent 会话流转中的大模型生成强行打断、历史上下文截断回退、以及敏感物理写操作前的冷备份物理快照和双轨倒带回退能力，防范模型陷入脏工作区或死循环，提升交互的安全性与规划纠错能力。

## Requirements

### Requirement: 阻断生成流
系统必须支持在调用大模型或处理长耗时逻辑时，响应强制中止信号，以打断当前的流转闭环。

#### Scenario: 强制打断响应 (双击 ESC)
- **WHEN** Agent 正在流式输出内容或发起大模型网络请求时，用户在终端双击了 `ESC` 键
- **THEN** 系统必须立即掐断长连接，抛出或捕获相应的 AbortError
- **THEN** 系统应清理尚未提交完整的脏数据（如收集了一半的 tool_calls 碎片），回到就绪态，并输出“已收到中断指令”的警告

### Requirement: 上下文记忆截断
系统必须提供方法对多轮对话的上下文进行精确回滚，以丢弃大模型错误发散的路径。

#### Scenario: 快捷单步回滚 (双击 ESC)
- **WHEN** 系统处于就绪输入态（非生成中）时，用户在终端双击了 `ESC` 键
- **THEN** 系统拦截输入并弹出确认提示 `确定要撤销上一轮对话吗？(y/N)`
- **THEN** 若用户确认 (y)，系统触发单步回滚 `rollback(1)`
- **THEN** 系统执行全局清屏 (`console.clear()`) 并重新遍历渲染剩下所有未被丢弃的历史对话，实现“时间倒流”的沉浸式效果

#### Scenario: 显式调用任意步数回滚 (/rollback)
- **WHEN** 用户通过终端输入 `/rollback N` 命令（N 为正整数）
- **THEN** 系统必须从 `messageHistory` 的尾部安全地弹出（pop/splice）对应 N 轮数量的上下文对象
- **THEN** 系统同样执行全局清屏，并重新渲染剩余的历史会话状态，抹除被丢弃的内容
- **THEN** 即使传入的回滚步数超界，系统也必须强行保留初始的系统设定消息（role: 'system'），绝不将其截断

### Requirement: 物理文件与会话内存快照记录 (Physical & Context Session Snapshotting)
系统必须(MUST)在触发具有物理文件修改副作用的写操作工具（其元数据声明 `securityCategory === 'write'`）执行前，自动对目标文件在 `.myagent/backups/` 目录下创建冷备份快照，并且系统必须(MUST)在 `SessionContext` 中保存对应的会话历史索引，确立物理文件与内存会话双轨绑定的快照点。

#### Scenario: 敏感写操作触发物理快照备份
- **WHEN** 智能体即将调用具有 `edit` / `write` 副作用的工具 `editFile` 且参数 `targetPath` 指向 `src/index.ts`。
- **THEN** 系统在实际执行该工具的物理写入前，自动将 `src/index.ts` 文件的原始内容冷备份存盘至 `.myagent/backups/` 目录下，并以递增版本或哈希进行版本追踪；同时在内存 `SessionContext` 中生成快照点记录（Snapshot Record），保存当前的 `messageHistory` 消息长度基准。

### Requirement: 敏感编译失败触发双轨一致性回滚 (Coordinated State Rollback)
当智能体在连续开发步骤中出现编译严重报错、死循环或规划卡死，向引擎发出回退动作时，系统必须(MUST)执行双轨一致性倒带回滚：将备份物理文件写回以覆盖脏文件，利用 `unlink` 彻底删除该快照点后产生的增量新建文件，并且将内存中的 `messageHistory` 指针截断回上一个快照点对应的长度基准。

#### Scenario: 智能体卡死触发双轨倒带
- **WHEN** 智能体触发回退命令并指向指定快照点。
- **THEN** 系统立即读取 `.myagent/backups/` 中该快照点的备份文件覆盖并恢复 `src/index.ts` 的原始内容；彻底 `unlink` 物理删除自该快照点后所有新建的文件；并将 `SessionContext.messageHistory` 强行截断至快照记录保存的数组长度，使智能体及工作区环境同步回滚到之前的安全状态。
