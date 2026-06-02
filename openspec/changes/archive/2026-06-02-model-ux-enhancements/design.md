## 背景

系统目前依靠原生的 `readline` 实现纯文本问答，在遇到需提供多选项分支或配置注入时（例如动态切换带有复杂推理参数的模型），传统命令行的输入输出无法提供友好的操作反馈。另外，原有的架构设计缺乏将运行时修改（如默认模型）回写到持久化存储（`.env`）的基础组件。我们需要引入轻量级的 UI 层，并贯通“UI 选择 -> 参数注入 -> 全局配置持久化”的数据流。

## 目标与非目标

**目标:**
- 引入 `@clack/prompts`，实现在输入 `/model` 时唤起向导。
- 向导结束后，能够恢复原生的 `readline` 提示符（无闪烁或错位），并且 Prompt 动态更新以展示当前激活的模型。
- `buildExtraPayload` 能接收参数 `options`，由向导收集并传递。
- 实现 `utils/env.ts`，基于正则替换 `.env` 字段，实现配置的安全写入。

**非目标:**
- 将整个 Agent 会话系统改写为 React 驱动（即排除 `ink` 方案），坚持核心逻辑与 UI 解耦。
- 实现配置文件 `.env` 以外的其他复杂存储机制（如 SQLite 或 JSON）。

## 架构决策

- **外观适配器模式 (Adapter for UI) [Amend 修正]**: `@clack/prompts` 将仅仅作为 `command.ts` 中的一个临时弹出层。在向导开启期间，仅仅 `pause` 主 `readline` 是不够的，必须在 `index.ts` 中完全调用 `rl.close()` 销毁旧实例以防 `stdin` 事件冲突，结束后再调用 `initRl()` 重新恢复。这保证了底层会话流的绝对纯粹。
- **环境配置文件的正则式回写**: 不使用诸如 `dotenv-writer` 这样重量级且可能破坏注释的库，而是使用 Node.js 的 `fs` API，针对 `DEEPSEEK_MODEL=` 及 `DEEPSEEK_REASONING_EFFORT=`，用正则式进行精准行替换。如果没有匹配项，就在末尾追加。这最大程度降低了对已有注释格式的破坏风险。
- **动态 Payload 函数签名变更 [Amend 修正]**: `ModelProfile.buildExtraPayload?: (options?: Record<string, any>) => object;`，通过修改此签名，`command.ts` 从向导获取到的 `{ reasoning_effort: 'high' }` 将通过 `session.switchModel(model, options)` 传入并保留在 session 实例中，每次请求时调用 `buildExtraPayload(session.modelOptions)` 生成动态参数。对于 DeepSeek 等模型，此过程需严格按官方规范组装 `thinking: { type: "enabled" }`。

## 风险与权衡

- **终端光标冲突风险**: `readline` 与 `@clack/prompts` 同时争夺终端控制权可能导致显示乱码（例如按向上键时控制台回显残留）。
  - *缓解措施*: 如架构决策所述，彻底解绑并关闭当前 REPL 的 `readline` 实例，将 `stdin` 全权移交 `@clack/prompts`。
- **流式输出时重写 Prompt 导致闪烁**: 如果模型返回处于 streaming 状态，此时更改 Prompt 会有冲突。
  - *缓解措施*: 将 Prompt 的更新收敛在 `index.ts` 暴露的方法中，确保只在空闲等待用户输入时更新终端状态字。
