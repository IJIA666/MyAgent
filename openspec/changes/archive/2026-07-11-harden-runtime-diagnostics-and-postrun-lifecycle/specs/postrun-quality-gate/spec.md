## ADDED Requirements

### Requirement: 质量门禁只能由真实或不确定代码写入触发

系统必须（MUST）根据单次调用实际 effect 与受影响资源决定是否运行质量门禁，不得仅因工具静态安全类别为 write 就触发。

#### Scenario: 只读命令不触发质量门禁

- **WHEN** 一轮交互只执行了实际 effect 为 read 或 none 的工具调用
- **THEN** 系统不得运行 ESLint、TypeScript 或其他修改后质量检查

#### Scenario: 真实代码修改触发质量门禁

- **WHEN** 一轮交互至少成功产生一个指向代码资源的 write effect
- **THEN** 系统必须在最终 complete 之前运行配置的质量检查

#### Scenario: 无法排除代码写入

- **WHEN** 工具执行返回 unknown effect，且资源为空或与工作区代码范围相交
- **THEN** 系统必须保守触发质量门禁，并在结构化诊断中记录 unknown 原因

### Requirement: 质量门禁必须有界反馈并避免无变更重跑

质量门禁失败后系统必须（MUST）允许模型执行有界修复，但不得形成无限自修复循环，也不得在没有新增代码写入时重复运行检查。

#### Scenario: 首次质量检查失败并修复

- **WHEN** 首次质量门禁失败且尚未使用自动修复机会
- **THEN** 系统必须把脱敏后的失败摘要反馈给模型，并允许最多一次自动修复轮

#### Scenario: 修复轮未发生写入

- **WHEN** 自动修复轮结束但没有产生新的 write 或相关 unknown effect
- **THEN** 系统不得再次运行质量门禁，必须返回失败状态并结束自动修复

#### Scenario: 修复后仍未通过

- **WHEN** 自动修复后的第二次质量门禁仍失败
- **THEN** 系统必须停止自动重试，向用户呈现失败摘要并继续走唯一 complete 终结点

### Requirement: 质量门禁必须支持取消与步骤计时

质量检查适配器必须（MUST）接收 AbortSignal，并为每个检查步骤返回状态、耗时与摘要。

#### Scenario: 会话关闭时取消质量检查

- **WHEN** 质量门禁运行期间会话关闭或当前生成被 abort
- **THEN** 适配器必须终止后续检查，返回 cancelled 状态，并不得阻塞会话关闭

