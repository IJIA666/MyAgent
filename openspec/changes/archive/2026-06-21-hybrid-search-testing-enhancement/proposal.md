# Proposal - Hybrid Search Testing Enhancement

本项目已完成了长期记忆双路混合检索与 RRF 融合重排的核心功能开发。本变更（Change: `hybrid-search-testing-enhancement`）旨在针对前期探索中发现的测试死角进行补强，确保在各种极端与故障环境下系统的健壮度。

## 1. 问题与现状
当前在 [plugins.test.ts](file:///d:/Projects/MyAgent/test/brain/plugins.test.ts) 中的测试已经完成了大部分的主干链路验证，覆盖率达到了 92% 以上。然而，仍有以下两个关键逻辑没有自动化测试用例进行防护：
- **单路容错防线**：在 `handleBeforeModel` 中，我们为向量检索与物理关键字检索分别设计了独立的 `try-catch`。如果向量数据库或 embedding 计算抛出异常，理应由物理检索路无缝接管（后备降级），反之亦然。目前缺少对此类抛错接管场景的 Mock 异常测试。
- **超长消息防御性截断**：代码中对超过 2000 字符的用户 Query 会执行 `substring(0, 2000)` 防御性截断，以防止超量 token 消耗与 LLM 拒绝服务。目前没有测试对此截断行为进行数值边界校验。

## 2. 目标与收益
- **完善测试套件**：在 `test/brain/plugins.test.ts` 中针对上述两类边界，增补精细化的单元/集成测试用例。
- **保障容错机制**：通过 Mock 抛出错误的方式，确保单路异常下智能体洋葱钩子管道不会崩溃，且另一路能平稳返回有效记忆。
- **提升质量保障**：将测试覆盖率提升到 95% 以上，防止后续任何重构破坏此关键防线。

## 3. 影响范围
- 测试文件：[plugins.test.ts](file:///d:/Projects/MyAgent/test/brain/plugins.test.ts)
- 不影响任何现有的业务代码和系统架构，保持向后兼容性。
