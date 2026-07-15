## REMOVED Requirements

### Requirement: 质量门禁状态必须位于 complete 之前且不得终结渲染

**Reason**: 自动质量门禁删除后不再产生 `quality_check_status` AgentEvent。

**Migration**: `complete` 继续作为每轮唯一状态终结点；显式终端检查只通过正常工具调用事件和结果反馈。

