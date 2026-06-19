# 探索主题: 配置加载与模型工厂单元测试覆盖率评估

## 1. 问题定义
我们在变更 `generic-llm-config-refactor` 中，对大模型配置的环境变量前缀进行了泛化重构，并重构了类型系统与校验架构（将推理努力度的 Fail-Fast 值域校验下放至 `models.ts` 的 `getModelConfig` 中）。
本探索旨在审视当前配置模块的单元测试是否足够，是否存在测试盲区与潜在漏洞，并确定提升测试健壮性的推荐方向。

## 2. 关键发现与调研结果
- **代码库现状**：
  - 核心配置校验逻辑已由原先的 `loader.ts` 转移至 `models.ts` 中的 `getModelConfig(id, env)`。
  - 目前仅在 [loader.test.ts](file:///d:/Projects/MyAgent/test/config/loader.test.ts) 中对 `reasoningEffort` 进行了基础的隔离注入读取测试（预期其为 `'high'`）。
  - 在 [models.test.ts](file:///d:/Projects/MyAgent/test/brain/models.test.ts) 中，**完全没有**针对 `AGENT_LLM_REASONING_EFFORT` 环境变量提取、值域校验以及异常拦截的测试用例。
- **核心测试盲区**：
  1. **异常拦截盲区**：当用户在配置中传入了非法的思考等级（如 `AGENT_LLM_REASONING_EFFORT=extreme`）时，`getModelConfig` 应该通过 Fail-Fast 抛出错误以终止进程，这部分没有编写测试，存在功能回退风险。
  2. **空值安全放行盲区**：环境变量未定义（`undefined`）或为空白字符串时系统必须无痛放行并赋为默认配置，此安全兜底路径同样没有用例保障。
  3. **值域边界未打透**：没有对 `'low' | 'medium' | 'high' | 'max' | 'disabled'` 这一组只读常量字面量在 `getModelConfig` 的自适应装配做全覆盖测试。

## 3. 方案对比与推荐方向

| 评估维度 | 方案 A (维持当前测试) | 方案 B (补齐配置值域与异常拦截单测) | 结论 |
| :--- | :--- | :--- | :--- |
| **重构回归保障** | 弱 ✗ (未来如修改校验值域或下放逻辑，难以立刻发现错误) | 极强 ✓ (通过断言异常和边界值对重构形成坚实保护) | 方案 B 占优 |
| **外部契约对齐** | 差 ✗ (未在测试层面强制约束非法值行为) | 优秀 ✓ (契约的每个边界都有对应的单测场景) | 方案 B 占优 |
| **测试实施成本** | 零 ✓ | 低-中 ✗ (需要在 `models.test.ts` 中追加 3-4 个用例) | A 占优 |

**推荐路径**：
为了建立高可信的 Agent 重构底座，我们强烈推荐采用 **方案 B (补齐配置值域与异常拦截单测)**。
应在 `models.test.ts` 中追加专门的 describe 块，针对推理努力度的校验逻辑，覆盖以下三条路径：
- 非法值 Fail-Fast 报错路径（如配置为 `invalid-val` 时抛出 Error）；
- 空值（未配置、空字符串）安全放行路径；
- 合法边界值正确解析路径（如 `low`, `max`, `disabled`）。

## 4. 约束、风险与未知项
- **环境变量污染风险**：在 `models.test.ts` 中通过修改 `process.env` 进行全局测试时，如果 `afterEach` 没有恢复环境变量，可能会导致其他测试出现连锁失败。需要在编写测试时，强制要求在 `beforeEach` 与 `afterEach` 中进行严格的环境变量镜像保存与恢复。

## 5. 否决方案
- **在 loader.test.ts 中测试此逻辑**：
  - *否决原因*：推理努力度的 Fail-Fast 校验已经彻底从 `loader.ts` 剥离并下放到了 `models.ts`，按照单一职责与模块化测试原则，这部分测试应当内聚在 `models.test.ts` 内部，而不应在通用加载器测试中进行跨模块测试。
