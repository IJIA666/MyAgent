## RENAMED Requirements

- FROM: `质量门禁与诊断阶段必须形成可关联 trace span`
- TO: `诊断阶段必须形成可关联 trace span`

## MODIFIED Requirements

### Requirement: 诊断阶段必须形成可关联 trace span

系统必须（MUST）在 trace 中记录实际 effect、目录测量和技能缓存刷新阶段，使开发者无需通过时间空洞推断延迟来源。记录内容必须遵守当前 capture mode 与脱敏规则。

#### Scenario: metadata-only 目录测量 trace

- **WHEN** 默认 metadata-only 会话执行受限目录测量
- **THEN** trace 必须记录预算、实际成本、完整性和错误计数，路径使用工作区相对形式或不可逆摘要

#### Scenario: replay 模式保存详情

- **WHEN** 用户在会话启动前显式开启 replay
- **THEN** 系统可以保存回放所需的更多阶段详情，但仍必须执行秘密字段、用户模式、超长值和日志注入字符脱敏

