## 改造原因

当前系统在环境变量中硬编码了模型相关的配置（URL、Model、Key），同时在 `session.ts` 请求底层接口时硬编码了特定的 API 载荷（如 DeepSeek 特有的 `reasoning_effort` 和 `thinking` 参数）。这导致当我们在需要不同强度的推理或由于 API 限制需要无缝切到非 DeepSeek 阵营模型（如 GPT-4o 或 Claude）时，系统容易由于入参不支持而崩溃，且每次调整均需修改 `.env` 甚至修改代码，无法满足现代单次长会话多模型间灵活热切换的最佳实践。

## 变更内容

- 引入内置模型注册表（Model Registry），预置 DeepSeek-V3、DeepSeek-R1、GPT-4o、Claude-3.5 等常见模型对应的目标模型名、Base URL 以及特有 API 请求 Payload（如 thinking 配置）。
- 在 `index.ts`（交互层）中拦截新的 Slash Command，即 `/model <model-id>`。
- 在 `session.ts` 的模型对话方法中，将原有的硬编码推理参数替换为依据当前激活 Model Registry 动态展开配置的逻辑。
- 在检测到 API Key 不存在或配置不完整时，给出优雅的使用提示，而不是底层 API 崩溃。
- [Amend 修正] 将 Slash Command 的解析与分发逻辑从 `index.ts` 中剥离，建立独立的 CommandRouter 模块，以符合开闭原则，支持未来扩展 `/help` 等更多指令。

## 业务能力

### 新增业务能力
- `dynamic-model-selection`: 支持系统维护多套模型预设字典，并提供在对话交互过程中通过 `/model` 命令实现当前会话大模型热切换的能力。

### 修改业务能力
- `config-management`: 从仅支持单环境配置，拓展为支持环境凭证白名单（如检测不同模型的专用 Key）。
- `simple-agent-core`: 扩展对 Slash Command 的输入拦截与状态管理分发。

## 影响范围

- `src/config.ts`: 将加入模型注册表的预置数据结构定义和查找逻辑，拓展凭证校验逻辑。
- `src/session.ts`: `chat.completions.create` 的参数组装逻辑需要动态化。
- `src/index.ts`: 控制台的 REPL 事件输入处理需追加命令检测与分发分支，并将实际分发委派给独立的路由模块。
- `src/command.ts`: [Amend 新增] 全新的命令路由与处理器模块。
