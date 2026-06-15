## 改造原因

目前的高阶终端执行工具 `terminal.ts` 将进程执行引擎、安全过滤正则、配置文件读写以及控制台交互逻辑等多种不同领域的职责杂糅在单个文件内，导致其行数激增且各层级职责高度耦合。这不仅违背了单一职责原则（SRP），也给编写高覆盖率的细粒度单元测试带来了很大困难。为了提高代码库的可维护性和内聚度，我们需要对该终端执行工具进行一次彻底的技术架构解耦与纵向拆分。

## 变更内容

1. **职责纵向拆分**：将现有的单个终端工具解耦重构为 4 个职责单一的高内聚模块：
   - `terminal-engine.ts`：纯净底座，处理 `spawn` 子进程、超时定时器监控及进程树强杀。
   - `terminal-guard.ts`：安全防护，处理正则防注入拦截与沙箱 cwd 边界校验。
   - `terminal-config.ts`：配置持久化，处理工作模式与白名单规则的 JSON 存取。
   - `terminal-interactive.ts`：用户交互，封装控制台人机确认界面。
2. **保持门面兼容**：在 `tools.ts` 门面层对这些模块进行组合调用，确保向大脑层暴露的 `executeCommandTool` 工具接口参数及表现完全兼容，实现底层无感重构。
3. **测试重组与覆盖**：重整并补全 [terminal.test.ts](file:///D:/projects/MyAgent/test/action/terminal.test.ts) 下的单元测试用例，分别独立验证重构后的各模块行为是否依然准确。

## 业务能力

### 新增业务能力
- 无

### 修改业务能力
- 无

## 影响范围

- 物理删除原 [terminal.ts](file:///D:/projects/MyAgent/src/action/native-tools/terminal.ts) 文件。
- 新增 `terminal-engine.ts`、`terminal-guard.ts`、`terminal-config.ts`、`terminal-interactive.ts` 文件。
- 修改 [tools.ts](file:///D:/projects/MyAgent/src/action/tools.ts) 门面。
- 重构 [terminal.test.ts](file:///D:/projects/MyAgent/test/action/terminal.test.ts) 单元测试用例。
- 外部功能、工具注册以及 LLM 交互接口全部无损且完全保持向前兼容。
