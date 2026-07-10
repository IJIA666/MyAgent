# 探索主题：运行时超时配置契约漂移

## 1. 问题定义

当前仓库的配置漂移集中在两个运行时超时字段：类型允许它们缺失，加载器没有装配它们，消费方则各自定义相同的回落默认值。结果是字段看似属于 `RuntimeLimitsConfig`，实际却不能从统一配置入口生效。

## 2. 代码核验结果

- `src/config/types.ts` 将 `modelTimeoutMs`、`subAgentTimeoutMs` 声明为可选字段。
- `src/config/loader.ts` 组装 `runtimeLimits` 时没有写入这两个字段，但其余必填字段都由加载器赋值。
- `src/core/usecases/engine/agent-loop.ts` 使用 `modelTimeoutMs ?? 60000` 创建单次模型请求的 `AbortSignal.timeout`。
- `src/core/usecases/brain/MemoryService.ts` 的构造函数已经要求 `AppConfig`，但读取 `subAgentTimeoutMs` 时仍使用可选链与 `?? 60000`。
- `src/config/models.ts` 中的 `AGENT_LLM_TIMEOUT` 控制底层 OpenAI 客户端网络超时，默认 `600000` 毫秒，不能直接等同于 AgentLoop 的 `60000` 毫秒外层调用超时。
- `.myagent/tool-outputs` 是 `openspec/specs/tool-output-offloading/spec.md` 已明确规定的行为，不是本 change 可自由调整的普通硬编码。
- 日期 locale 与 system-reminder 当前位于 `model-request-assembler.ts`，原探索所指向的 `agent-loop.ts` 已发生结构漂移。

## 3. 方案比较

| 方案 | 防止漏装配 | 复杂度 | 结论 |
| :--- | :--- | :--- | :--- |
| 保持字段可选，由消费方继续回落 | 无 | 低 | 否决，继续保留契约漂移 |
| 运行时反射 TypeScript 接口字段 | 不可直接实现 | 高 | 否决，接口会在编译后擦除 |
| 额外维护运行时 schema / 字段清单 | 可以 | 中高 | 当前仅两个字段，收益不足 |
| 字段改为必填，由加载器统一装配 | 可以，编译期失败 | 低 | 推荐 |

## 4. 推荐边界

本 change 只完成以下闭环：

`RuntimeLimitsConfig 必填字段 → loadConfig 环境变量与默认值装配 → AgentLoop / MemoryService 消费 → 定向测试`

其他硬编码议题应在出现真实需求时分别探索，不能用“全局搜索魔法值并酌情处理”作为不可穷尽的实施任务。

## 5. 风险与未知项

- `SessionContext` 允许先构造、后注入 `AppConfig`；消费点需要显式维护“执行前配置已注入”的不变量。
- 类型收紧会影响测试夹具，但这正是编译期约束发挥作用的表现，不应通过重新改回可选字段规避。
- 新环境变量只控制现有两处外层超时，不应顺带改变 OpenAI SDK 的网络超时语义。
