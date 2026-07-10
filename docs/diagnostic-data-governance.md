<!--
  诊断数据治理说明。
  本文描述本地 run.log、trace、audit 的采集边界，不改变 session snapshot 的恢复契约。
-->

# 诊断数据治理

## 三档策略

系统按制品类型固定映射诊断策略：

- `operational`：用于 `run.log` 和默认 trace，只记录事件、关联标识、状态、耗时、计数、长度和不可逆摘要。
- `audit`：用于插件审计，记录事件顺序、策略结果、资源摘要、patch 操作/路径摘要和不可逆指纹。
- `replay`：只用于显式开启的 trace，保留离线回放需要的正文，但仍强制清理 secret、token、authorization、password、headers 等基础敏感字段。

默认启用 `operational` 与 `audit`，关闭 `replay`。开启 replay 前应确认 trace 会持久化 prompt、上下文、reasoning、工具参数和结果，并只适合短期受控排障。

## 配置

配置由 `.env` 加载边界解析：

- `AGENT_DIAGNOSTIC_REPLAY=true` 显式开启 replay。
- `AGENT_DIAGNOSTIC_PATTERNS` 使用 JSON 字符串数组添加组织自定义脱敏 pattern。pattern 数量、长度和正则语法均受限，非法配置不会回显原始值。
- `AGENT_TRACE_RETENTION_DAYS`、`AGENT_AUDIT_RETENTION_DAYS` 默认 7 天，最大 30 天。
- `AGENT_TRACE_RETENTION_SESSIONS`、`AGENT_AUDIT_RETENTION_SESSIONS` 默认 20 个会话文件，最大 100 个。

trace 与 audit 在写入器创建时清理过期或超量的非活跃文件，并保护当前会话。清理失败只记录受治理事件，不阻断 Agent。`run.log` 继续独立使用 10MB × 5 轮转策略。

## 恢复快照边界

`.myagent/sessions` 下的 session snapshot 属于恢复状态，不是诊断制品。本 change 不对其做 sanitizer 或 metadata-only 改写，以保持完整消息、checkpoint summary、recent files 和 pending interaction 的保存、加载与恢复语义。snapshot 的敏感数据治理必须另行立项。

历史完整 trace 默认按旧格式读取并可 hydration；新 metadata-only trace 会明确声明 capture mode，读取器只提供诊断信息，不会将其误当成完整回放数据。
