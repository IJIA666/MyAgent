# 变更验收说明（Walkthrough）

本项目针对智能体环境感知缺失、前缀缓存频繁失效、缺乏代码质量校验和高危行为缺乏底层拦截等问题，进行了一系列系统提示词和缓存控制的重构。现已全量完成开发并跑通全部单元测试。

## 变更明细

### 1. 原生高精度时间工具
- 新建了只读无副作用的 `getCurrentTimeTool` 工具，并挂载至系统的 `toolRegistry` 中。
- 保证了模型可以通过 Tool Call 随时调起高精度系统时间戳，避免提示词中包含高频变动的分秒时间导致缓存失效。

### 2. 规则 Token 熔断拦截
- 对 `src/brain/contextLoader.ts` 引入了 20KB 大小软熔断拦截。
- 若规则文件（如 `global_rules.md` 或 `rules/guize.md`）大小超过 20KB 阈值，底层执行物理截断并注入特定的熔断指示语，防止模型上下文 OOM。

### 3. 三层 XML 缓存隔离重构
- 重构了 `buildSystemPrompt`（`src/brain/prompts/prompts.ts`），建立 `stable`、`context`、`volatile` 三层物理与语义隔离。
- 优化了核心 persona 人设、规则限制和工作路径的缓存结构，使得核心提示词能实现 100% 的前缀缓存命中。

### 4. PostRunHook 质量校验
- 引入了代码静态规范（eslint）与编译类型检查（tsc）后置自测机制（`AgentLoop.chat`）。
- 一旦智能体在一轮会话中执行了修改代码的操作，并在得出完成结论时，底层执行 `npm run lint` 和 `tsc` 检测。如果出错，则自动把控制台报错信息注入回会话上下文，驱使模型继续修正，形成闭环。

### 5. 底层危险操作审批卡关
- 在虚拟 MCP 引擎层（`LocalFileSystemMcpServer.callTool`）对高危文件删除（`deletePath`）和覆盖性写入（`writeFile` 已存在文件）进行了底层拦截。
- 结合系统自带的 `ApprovalService` 挂起执行并通知用户授权，遮蔽子工具的二次审批弹窗。

## 测试验证情况

已成功通过以下测试：
1. **自动编译**：通过 `npm run build`，编译完全正常，无任何 TypeScript 语法或类型报错。
2. **全量单元测试**：通过 `npm run test`，执行了全部 95 个用例（包含新增加的 4 个硬拦截测试），100% 通过。
