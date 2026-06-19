## 修改需求

### Requirement: 核心模块单元测试自动化校验
为了保障系统在持续迭代中的稳定性与安全加固的有效性，系统核心逻辑（包含绝对路径沙箱校验与 MCP 客户端生命周期注销）必须（MUST）编写自动化单元测试。全部单元测试用例在不需要物理启动外部 stdio 进程的前提下，必须（MUST）能够一次性全部通过。

#### Scenario: 自动化执行单元测试且用例全部通过
- **WHEN** 开发者或持续集成（CI）系统在终端中执行测试命令 `npm run test`
- **THEN** 自动化测试驱动器（Vitest）必须在本地 ESM 内存环境中迅速拉起所有测试套件，且最终测试结果必须 100% 成功通过。

#### 场景: 环境变量思考等级非法字面量配置阻断校验
- **WHEN** 开发者在测试中为 `process.env.AGENT_LLM_REASONING_EFFORT` 设置了不在支持字面量集合（如 `extreme`）内的值并调用 `getModelConfig`
- **THEN** 测试应当预期 `getModelConfig` 抛出包含 `不合法的 AGENT_LLM_REASONING_EFFORT 值` 文本的 Error 异常

#### 场景: 环境变量思考等级合规取值校验
- **WHEN** 开发者在测试中为 `process.env.AGENT_LLM_REASONING_EFFORT` 注入合规字面量（如 `low`、`max`、`disabled`）并调用 `getModelConfig`
- **THEN** 系统必须无痛放行，且返回的配置中 `reasoningEffort` 属性值必须精准匹配该字面量

#### 场景: 环境变量思考等级空值放行校验
- **WHEN** 环境变量中的 `AGENT_LLM_REASONING_EFFORT` 未配置（`undefined`）或为空白字符串（`""`）并调用 `getModelConfig`
- **THEN** 系统必须正常启动并放行，其返回的配置中 `reasoningEffort` 属性必须为 `undefined`
