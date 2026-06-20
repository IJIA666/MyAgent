## 1. 原生高精度时间工具与注册

- [x] 1.1 在工具链定义模块中，新增原生、只读且无副作用的 `getCurrentTimeTool` 工具。返回当前的 ISO 格式高精度时间戳与本地时间。
- [x] 1.2 将 `getCurrentTimeTool` 挂载注册至系统的 `toolRegistry` 中，使其可被智能体显式调起。
- [x] 1.3 编写该时间工具的单元测试，断言 `get_current_time` 在被调起时能正确无参数执行且返回结构完整的高精度系统时间。

<!-- checkpoint: npm run build -->

## 2. 规则加载器 Token 软熔断拦截与复用

- [x] 2.1 在 `src/brain/contextLoader.ts` 加载本地现有 `.agent/global_rules.md` 和 `.agent/rules/guize.md` 规则文件时，增加文件大小检测。
- [x] 2.2 实现文件大小超过 20KB（或 5000 字符）的安全物理截断，并在被截断的内容末尾附加提示语，防止上下文窗口耗尽。
- [x] 2.3 编写自动熔断与截断的单元测试，模拟载入超长文件，断言内容被安全截断且末尾包含特定熔断标志。

<!-- checkpoint: npm run test -->

## 3. System Prompt 三层 XML 缓存隔离重构

- [x] 3.1 在 `src/brain/prompts/prompts.ts` 中精细化重构 `BASE_SYSTEM_PROMPT`，加入最小重构、TSDoc/JSDoc 规范、专用工具优先、命令原子化等核心工程红线条款。
- [x] 3.2 在 `src/brain/context.ts` 的 `SessionContext` 初始化中，重构单个 System 消息组装结构，通过标准的 XML 标签构建物理三层隔离（`stable`、`context`、`volatile`），并将技能目录 `<available_skills>` 和本地现有规则移入 `<context_rules>` 隔离层。
- [x] 3.3 编写单元测试（对应 `test/session/prompt.test.ts`），断言在 CWD 切换、本地现有规则存在/不存在等边缘场景下，最终组装出的单个 System Message 嵌套结构正确且稳定。

<!-- checkpoint: npm run test -->

## 4. 执行流底层 PostRunHook 校验与高危操作硬拦截

- [x] 4.1 在执行引擎层引入 PostRunHook 机制，在 Agent 完成写任务响应后，底层自动跑 lint/typecheck 校验并将报错反馈至会话历史。
- [x] 4.2 在原生工具执行引擎层，对涉及文件删除、强行覆盖等危险参数操作进行底层拦截，配合 `ApprovalService` 挂起执行并向用户弹窗索取授权，形成软硬结合的安全闭环。
- [x] 4.3 编写单元测试，模拟高危 tool_call 触发，验证底层引擎是否能够成功 Suspend 挂起执行流。

<!-- checkpoint: npm run test -->

## 5. ESLint 代码规范修复返工 (Verify Refactor)

- [x] 5.1 修复 `src/action/tools/system/time.ts` 中未使用参数导致的 eslint 报错（移除未使用的 args 和 sessionContext 参数）。
- [x] 5.2 修复 `src/action/virtual-mcp.ts` 中 catch 块内未使用的 e 对象的报错。
- [x] 5.3 修复 `src/brain/agent-loop.ts` 中 catch 块中 any 显式声明造成的 eslint 报错（改用 unknown 配合类型断言）。
- [x] 5.4 修复 `test/action/dangerous-intercept.test.ts` 中 vi.fn 回调内未使用参数 of 报错。

<!-- checkpoint: npm run lint -->
