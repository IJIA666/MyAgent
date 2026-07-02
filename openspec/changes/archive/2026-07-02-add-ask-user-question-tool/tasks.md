## 1. 端口契约：InteractionPort 与类型定义

- [x] 1.1 在 `src/ports/driven/session/` 下新建 `InteractionPort.ts`，定义 `AskUserPayload` 接口和 `InteractionPort` 接口（`askUser(payload, signal?): Promise<string>`）
- [x] 1.2 ~~在 `src/ports/index.ts` 或相关导出文件中导出新端口契约~~（项目采用直接文件导入，无 barrel 文件，无需操作）

<!-- checkpoint: npx tsc --noEmit -->

## 2. NativeTool 接口签名扩展

- [x] 2.1 在 `virtual-mcp.ts` 的 `NativeTool` 接口中，为 `execute()` 新增独立可选参数 `_interactionPort?: InteractionPort`（不并入 `_sessionContext`，保持职责分离）
- [x] 2.2 在 `ToolRegistryPort.ts` 端口接口的 `callTool()` 签名中，扩展 `sessionContext` 参数以支持 `InteractionPort` 透传；在 `virtual-mcp.ts` 的 `callTool()` 方法中，接收并传递 `InteractionPort` 实例到 `tool.execute()`
- [x] 2.3 在 `toolRegistry.ts` 的 `callTool()` 实现中，从外部注入的 `InteractionPort` 透传到 `localMcpServer.callTool()`

<!-- checkpoint: npx tsc --noEmit -->

## 3. 工具实现：AskUserQuestionTool

- [x] 3.1 新建 `src/adapters/tools/impl/interaction/` 目录
- [x] 3.2 实现 `ask-user-question.ts`：`AskUserQuestionTool` 类，实现 `NativeTool` 契约
  - `securityCategory: 'read'`，`name: 'ask_user_question'`
  - `definition` 包含完整的 OpenAI Function Calling schema（title 必填，options/multiSelect/allowFreeInput 可选）
  - `checkSafety()` 返回 `{ status: 'pass' }`
  - `filePathParamKey` 留空（不操作文件）
- [x] 3.3 实现 `execute(args, sessionContext, signal)` 方法：
  - 参数校验：title 非空字符串；options 为空且 allowFreeInput 为 false 时抛错
  - 通过 `sessionContext`（`InteractionPort`）调用 `askUser(payload, signal)` 挂起等待
  - 用户超时返回空字符串
- [x] 3.4 新建 `index.ts` 导出 `AskUserQuestionTool`

<!-- checkpoint: npx tsc --noEmit -->

## 4. CLI 层交互渲染

- [x] 4.1 在 CLI 适配器（`facade.ts` 或新建 `interaction-handler.ts`）中实现 `InteractionPort` 接口
  - `askUser(payload)` 内部流程：暂停 InputListener → 渲染交互界面 → 等待输入 → 恢复 InputListener → 返回结果
- [x] 4.2 实现差异化渲染函数 `renderAskUser(payload)`：
  - 固定选项模式：渲染带序号的选项列表，单选用数字选择，多选用勾选 + 确认
  - 自由输入模式：渲染文本输入框
  - 混合模式：选项列表末尾追加 "Other（自定义输入）"
  - 视觉风格与 `renderApproval()` 明确区分（标题前缀、颜色、提示语）
- [x] 4.3 处理超时：5 分钟无输入自动返回空字符串

<!-- checkpoint: npx tsc --noEmit -->

## 5. 工具注册与依赖注入

- [x] 5.1 在 `virtual-mcp.ts` 的 `LocalFileSystemMcpServer` 构造函数或初始化方法中注册 `AskUserQuestionTool` 实例
- [x] 5.2 在 CLI 启动流程（`index.ts` 或 `cli.ts`）中，将 `InteractionPort` 实现实例注入到 `ToolRegistry`（`ToolRegistry` 内部透传到 `LocalFileSystemMcpServer`），确保 `callTool` 链路的每一层都能传递到工具
- [x] 5.3 确认 `ask_user_question` 工具出现在 `getTools()` 返回的列表中，且 `securityCategory: 'read'` 确保 Plan 模式下不被裁剪

<!-- checkpoint: npx tsc --noEmit -->

## 6. 集成测试与端到端验证

- [x] 6.1 编写 `AskUserQuestionTool` 单元测试：参数校验、合法调用返回预期 payload、超时返回空字符串
- [x] 6.2 编写 CLI 交互渲染的单元测试（mock stdin/stdout）：固定选项、多选、自由输入、混合模式四种场景
- [x] 6.3 端到端冒烟测试：启动 agent 在 Plan 模式下发起一个需要用户决策的任务，验证工具出现在工具列表中、模型能调用、CLI 正确渲染、用户选择后 agent 正确消费返回结果

<!-- checkpoint: npx vitest run -->
