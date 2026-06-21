# 规格：测试覆盖率补强

定义测试覆盖率的规范与行为约束。

## ADDED Requirements

### Requirement: 核心服务覆盖率指标
系统底层核心服务的单元测试覆盖率必须 (MUST) 满足预设的安全阈值，以确保核心底座的高可靠性。

#### Scenario: 覆盖率校验与断言
- **WHEN** 执行单元测试并收集覆盖率报告。
- **THEN** 系统整体及 core/usecases 内部各服务（CompactionService, ContextRepository, ToolDispatcher, SecurityService, RuleManager）的 Statement 覆盖率均应当达到或超过设定的基线。
