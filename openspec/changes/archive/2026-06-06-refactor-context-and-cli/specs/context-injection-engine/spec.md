## 修改需求

### MODIFIED Requirements

### Requirement: CLI `/skill` Command
The system MUST provide a CLI command to manage and invoke skills dynamically.

#### Scenario: User invokes a temporary skill via CLI
- **WHEN** the user types `/skill <name> <task>`
- **THEN** the system extracts the specified skill content and dynamically pushes it along with the user's task to the LLM for that single execution turn. The skill MUST NOT be persistently mounted across turns.

## 废弃需求

### REMOVED Requirements

### Requirement: Hardcoded State Commands
- **Reason**: 强制挂载 (`pin`) 与强制禁用 (`disable`) 导致底层 System Prompt 被频繁篡改，造成提示词缓存失效并引发模型“注意力稀释”。
- **Migration**: 废弃 `/skill pin`, `/skill unpin`, `/skill enable`, `/skill disable` 以及内部存储中对应的状态数组。状态统一迁移至单次回合级别的“历史流动态入栈（History Stream Push-Pop）”，不再使用成员变量长久留存。
