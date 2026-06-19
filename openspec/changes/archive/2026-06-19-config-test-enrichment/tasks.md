## 1. 模型工厂配置校验单测补齐

- [x] 1.1 修改 `test/brain/models.test.ts`，在底部追加 `describe('getModelConfig 推理努力度 (Reasoning Effort) 校验与提取验证')` 独立测试套件，并实施 beforeEach 与 afterEach 的全局 process.env 镜像恢复，保障测试隔离性。
- [x] 1.2 编写异常拦截单测，注入非法的推理努力度环境变量（如 `extreme`），验证调用 `getModelConfig` 能够 Fail-Fast 抛出包含非法取值文字描述的 Error。
- [x] 1.3 编写空值放行单测，当环境变量 `AGENT_LLM_REASONING_EFFORT` 为未定义（`undefined`）或为空白字符串（`""`）时，验证调用 `getModelConfig` 能够平滑放行，且返回配置的 `reasoningEffort` 属性值为 `undefined`。
- [x] 1.4 编写合法值装配单测，针对合规字面量集合（如 `low`、`max`、`disabled`），验证调用 `getModelConfig` 后返回的 `reasoningEffort` 精准绑定为对应字面量。

<!-- checkpoint: npm run build && npm run lint && npm run test -->
