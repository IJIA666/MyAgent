## 1. 大文本拦截与分页读取工具

- [x] 1.1 在 `src/action/tools.ts` 中实现并注册 `read_temp_file_by_lines` 物理工具，提供行范围（`lineStart` 到 `lineEnd`）的分页文件内容读取能力。
- [x] 1.2 在 `src/action/tools.ts` 中为分页读取工具增加安全路径校验，利用 `secureResolvePath` 验证目标临时文件必须处于授权的沙箱区域内。
- [x] 1.3 在 `src/brain/session.ts` 的 `SessionManager` 中拦截超 8000 字符的工具输出，执行落盘到 `.myagent/temp/` 并在 `messages` 中写入带有 previews 摘要和分页读取工具引导的占位提示词。

<!-- checkpoint: npm run build -->

## 2. 状态估算与会话物理轮换

- [x] 2.1 在 `src/brain/context.ts` 中扩展 `SessionContext`，实现基于激活模型最大窗口百分比（默认 75%）的自适应 Token 阈值计算。
- [x] 2.2 在 `src/brain/session.ts` 中重构 ReAct 循环，在发起网络请求前，动态执行 Token 占用水位校验，一旦超出阈值则静默触发压缩逻辑。
- [x] 2.3 在 `src/brain/session.ts` 中接入 Session 并发锁定与数据库物理轮换，在压缩触发时物理结束旧会话、轮换新 `session_id` 并重置去重缓存。
- [x] 2.4 在 `src/brain/prompts.ts` 中实现 `buildCompactionSummaryPrompt()` 接口以组装包含开发决策、改动文件、未决问题和噪音过滤指令的总结 Prompt 模板。
- [x] 2.5 在 SessionManager 中实现调用 LLM (通过 LlmDriver) 触发同步提炼摘要的接口与机制。
- [x] 2.6 在 REPL 终端中暴露一键手动 Compact 压缩的控制命令。

<!-- checkpoint: npm run build && npm run lint -->

## 3. 时序 Checkpoint 追加与文件记忆重建

- [x] 3.1 在 `src/brain/adapters/DefaultContextAdapter.ts` 组装逻辑中，实现将剔除的历史摘要包裹于 `role: "user"` 的 `<conversation-checkpoint>` 消息块中，时序追加至新会话头部。
- [x] 3.2 实现 `collectReadToolFilePaths` 扫描机制，找出被剔除历史中最近被大模型读写过的代码文件，在新会话头部以 `<transient_file>` 轻量附件形式重建记忆。

<!-- checkpoint: npm run build && npx vitest run -->

## 4. 大模型与网络配置覆写及窗口自适应重构

- [x] 4.1 在 `src/config/types.ts` 中扩展 `ModelProfile` 与 `LlmConfig` 接口，新增定义 `contextWindow`、`temperature`、`timeout`、`maxRetries` 以及 `headers` 属性。
- [x] 4.2 在 `src/config/models.ts` 中重构 `getModelConfig` 工厂，并加入主动防御降级与后缀缩写自适应解析机制：一旦检测到模型名带有 `[1m]` 等后缀，自动解析窗口大小并物理剥除该后缀以防 API 报错；支持窗口配置中如 `1m`/`128k` 缩写格式的还原转换；若完全缺失窗口配置，自动降级为保守默认值 `32000` tokens。
- [x] 4.3 在 `src/brain/driver.ts` 中重构 `LlmDriver` 客户端实例化逻辑，在发起推理请求时将覆写合并后的 `temperature` 注入请求体，并将 `timeout`、`maxRetries` 以及自定义 `headers` 透传给底层的 API 客户端选项。
- [x] 4.4 在 `src/brain/context.ts` 中重构 `SessionContext.getCompactionThreshold`，彻底删除依据模型名字符串进行硬编码模糊猜测的冗余条件分支，仅使用配置对象窗口（若无效或非对象，缺省降级为保守安全默认值 `32000`）；同步修改 `SessionManager`（`src/brain/session.ts`）中 Token 水位估算与触发压缩的调用链。

<!-- checkpoint: npm run build && npm run lint && npx vitest run -->
