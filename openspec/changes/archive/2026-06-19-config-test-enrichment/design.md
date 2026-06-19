## 背景

系统在对配置模块完成“前缀去厂商化重构”（`DEEPSEEK_` ➡️ `AGENT_LLM_`）及“类型校验逻辑下放”（推理努力度合法性校验移入 `models.ts` 的 `getModelConfig`）后，需要补齐配套的测试用例。这能保证重构后的系统在应对非法环境变量配置、边界条件和空值情况时能始终表现符合预期，提升系统防退化保障能力。

## 目标与非目标

**目标:**
1. **测试边界全覆盖**：在 `models.test.ts` 中针对 `getModelConfig` 补齐推理努力度字段的测试用例。
2. **测试维度完备**：覆盖非法值异常拦截（Error 断言）、空值平滑放行兜底（未配置或空串）以及合法边界字面量值验证三条核心路径。
3. **环境污染绝对规避**：确保全局 `process.env` 的覆盖测试具备严密的还原隔离。

**非目标:**
1. **测试框架迁移与第三方扩展**：本次仅使用现有的 Vitest 测试套件编写原生单元测试用例，不引入任何新的测试驱动。
2. **其他不相干模块的测试补齐**：本次重构仅聚焦于模型工厂配置层（`models.ts`）的测试补齐，不延伸至其他非配置模块。

## 架构决策

### 决策一：在 `models.test.ts` 中新增内聚的 describe 块
- **技术细节**：新增 `describe('getModelConfig 推理努力度 (Reasoning Effort) 校验与提取验证', ...)` 测试套件。
- **理由**：因为推理努力度的提取和 Fail-Fast 校验已完全移入 `models.ts`，由该模块内聚管理。在这里编写用例能最大化保持测试的可读性与高内聚，方便开发者一目了然地定位异常。

### 决策二：使用 Vitest 的 `expect().toThrow()` 断言异常
- **技术细节**：
  ```typescript
  it('当传入非法的推理努力度时，必须 Fail-Fast 抛出明确错误', () => {
    process.env.AGENT_LLM_REASONING_EFFORT = 'extreme';
    expect(() => getModelConfig('deepseek-v4-flash')).toThrow('不合法的 AGENT_LLM_REASONING_EFFORT 值');
  });
  ```
- **理由**：确保在用户配错环境变量时，错误拦截机制能按预期生效抛出异常并阻断程序，直接反射在断言中。

### 决策三：空值平滑放行与合法字面量多用例断言
- **技术细节**：分别用 `undefined`、空字符串 `""` 验证其不报错且 `reasoningEffort` 属性为 `undefined`。同时，用 `low`、`max`、`disabled` 分别测试返回的 `LlmConfig.reasoningEffort` 正确赋为了对应的字面量。

## 风险与权衡

### 风险点：全局环境变量污染导致其他单测连锁失败
- **描述**：由于 Vitest 默认是并发或按序执行，修改 `process.env.AGENT_LLM_REASONING_EFFORT` 属于全局改动，若测试用例执行完未恢复，后续跑 loader 测试等可能会读取到脏数据。
- **缓解策略**：
  - 在 `beforeEach` 中对 `process.env` 进行浅拷贝备份，并在 `afterEach` 中将备份还原到 `process.env`，确保测试用例的环境无副作用。
