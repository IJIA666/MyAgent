## 1. 基础配置与类型扩展 (Infrastructure & Configuration)

- [x] 1.1 在 [src/config/types.ts](file:///d:/projects/MyAgent/src/config/types.ts) 中，将可选配置项 `enablePlanToolStripping?: boolean` 添加 to `AppConfig` 接口定义中。
- [x] 1.2 在 [src/config/loader.ts](file:///d:/projects/MyAgent/src/config/loader.ts) 的 `loadConfig` 方法中，解析 `.env` 配置文件或系统环境变量中的 `ENABLE_PLAN_TOOL_STRIPPING`，将其解析为布尔值注入到返回的 `AppConfig` 对象中（默认值为 `false`），并在初始化时冻结该配置。

<!-- checkpoint: npm run build -->

## 2. 提示词静态化改造 (Static Prompt Refactoring)

- [x] 2.1 修改 [src/core/usecases/brain/prompts.ts](file:///d:/projects/MyAgent/src/core/usecases/brain/prompts.ts) 中的 `buildSystemPrompt` 函数。
- [x] 2.2 彻底移除 `buildSystemPrompt` 内部对动态 `dateStr`、`cwdStr` 的拼装渲染，保留进程级静态常量 `osStr`，确保在整个会话生命周期内生成的 System Prompt 完全静态，不携带任何高频变动的变量。
- [x] 2.3 修正与 `buildSystemPrompt` 校验相关的现有单元测试中，因移除参数而导致断言不通过的问题。

<!-- checkpoint: npx vitest run test/adapters/tools/terminal.test.ts -->

## 3. 动态对话尾部气泡注入 (System Reminder Injection)

- [x] 3.1 在 [src/core/usecases/engine/agent-loop.ts](file:///d:/projects/MyAgent/src/core/usecases/engine/agent-loop.ts) 的 LLM 发送请求前（在获取 `messageHistory` 转化为 LLM 输入载荷时，或组装 parameters 之前）。
- [x] 3.2 动态获取 `SessionContext` 中当前的安全模式 `workMode`、当前工作目录 `cwd`，并获取当前系统日期 `date` 字符串。
- [x] 3.3 向前追溯定位到即将发送给 LLM 接口的消息列表中最近/最新的一条 `user` 角色消息，克隆它并在其 `content` 尾部拼装追加系统提醒 XML 气泡：`<system-reminder>\n[System Notification]\nDate: ${date}\nCwd: ${cwd}\nSecurityMode: ${workMode}\n</system-reminder>`。以临时载荷发送给 API，而不将该气泡数据写入物理的 `messageHistory` 历史消息存储，以规避非 user 末尾消息下的角色交替规则校验报错。

<!-- checkpoint: npm run build -->

## 4. 动态工具物理裁剪 (Dynamic Tool Stripping)

- [x] 4.1 在向大模型 API 组装 `tools` 参数的载荷转换模块中进行拦截。
- [x] 4.2 判断若全局配置 `appConfig.enablePlanToolStripping === true` 并且当前的运行态 `workMode === 'Plan'` 时，执行过滤。
- [x] 4.3 过滤剔除所有定义了 `securityCategory: 'write'` 属性的写倾向敏感工具（如 `execute_command`、`write_to_file`、`replace_file_content`），使得传递给 LLM 接口的 `tools` 定义中完全不包含写工具，完成物理隔离。

<!-- checkpoint: npm run build -->

## 5. 系统集成测试与功能验证 (Integration & Validation)

- [x] 5.1 编写新的单元测试用例，覆盖 System Prompt 静态化后的 Context Cache 保全表现。
- [x] 5.2 编写针对 Plan 模式下“动态气泡注入”和“写操作工具屏蔽”的测试场景，验证当开启/关闭 `enable_plan_tool_stripping` 时，发送给模型的 payload 结构是否与预期完全相符。
- [x] 5.3 运行全量测试套件，确认重构没有引发任何退化故障。

<!-- checkpoint: npm run test -->
