## 背景

当前系统的终端命令执行工具统一实现于单个庞大文件 `terminal.ts` 中。由于其内部集成了白名单拦截算法、控制台 TTY 交互、安全正则过滤以及 Node.js 的 `child_process.spawn` 底层进程流控与超时强杀逻辑，导致该文件的复杂性非常高，职责边界严重重叠。在之前的探索阶段我们达成共识，需要通过**方案 B (拆分为多模块架构)** 对这一模块进行高内聚解耦。

## 目标与非目标

**目标:**
- 将原有的单文件 `terminal.ts` 纵向重构成 4 个独立的子文件：
  - `terminal-engine.ts`：纯进程控制底层（处理 spawn 封装、数据监听、流截断防爆溢写、超时双定时器与进程树强杀）。
  - `terminal-guard.ts`：纯安全过滤网关（处理正则复合字符拦截与 sandboxed cwd 范围判定）。
  - `terminal-config.ts`：配置持久化管理器（处理 Allowed Commands 白名单及 Work Mode 安全工作模式的磁盘 JSON 存取）。
  - `terminal-interactive.ts`：人机交互提示器（负责封装控制台询问输入接口）。
- 在门面层 [tools.ts](file:///D:/projects/MyAgent/src/action/tools.ts) 中对各子模块进行拼装组合，确保导出的 `executeCommandTool` 方法签名与外部暴露行为完全等效且向前兼容。
- 重新整理和丰富 [terminal.test.ts](file:///D:/projects/MyAgent/test/action/terminal.test.ts) 中的测试用例，分别覆盖到各个子模块，并保持构建 (`npm run build`)、Lint 检测 (`npm run lint`) 和全量单元测试 (`npm run test`) 百分之百通过。

**非目标:**
- 不引入任何新的命令执行能力。
- 不修改原有的安全拦截硬编码正则表达式，亦不改变任何白名单文件的存储格式。
- 不增加或改动用户的交互选择项。这完全是一次等效代码重构。

## 架构决策

1. **组合式门面模式 (Facade Pattern)**：
   - 重构拆分后的 4 个子模块完全隐藏在 `native-tools` 内部。清空原 `terminal.ts` 业务逻辑并改造为纯粹的 Facade 门面，在其中组装 4 个子模块并导出 `executeCommandTool`。在 `tools.ts` 中仅作直接导出，从而保持全局工具注册表的精炼与职责纯粹，使得外部大脑层和本地虚拟 MCP 服务对该重构零感知。
2. **纯净无状态的进程引擎 (Pure Subprocess Engine)**：
   - `terminal-engine.ts` 应当是一个不依赖具体安全规则、不依赖特定白名单文件和控制台交互的纯净底座。它只接受基础的 `command`、`cwd`、`isBackground` 和超时参数，安全和交互逻辑通过回调/前置拦截的形式注入执行，从物理上隔断了循环引用，并大幅提升了进程控制底座在非交互环境下的复用性。
3. **依赖方向单向化**：
   - `terminal-interactive.ts` 依赖 `terminal-config.ts` 来写入被“始终放行”的前缀。
   - `tools.ts` 作为门面，汇聚并编排 `terminal-guard.ts`、`terminal-config.ts`、`terminal-interactive.ts` 和 `terminal-engine.ts` 形成完整的执行工作流，保障不发生双向依赖和循环导入。
4. **控制台交互串行队列 (Serial Console Interaction Queue)**：
   - 所有并发调用的 `askUserPermission` 必须通过一个全局 Promise 队列进行串行化流控。在上一个提问结束（Resolve）之前，下一个提问不可被激活创建，从而规避并发对控制台 `stdin` 资源的争抢。

## 风险与权衡

- **循环依赖 (Circular Dependency)** -> 拆分为 4 个文件后，如果配置管理、安全网关、交互组件和执行引擎相互调用，可能引发循环引用。
  * *缓解策略*：通过严格的自上而下单向数据流设计。在 `tools.ts` 内进行全生命周期组合，引擎层绝不反向导入任何交互或配置模块，所有需要的校验结果和放行回调一律在调用 `executeCommandTool` 时作为参数或状态前置处理。
- **单元测试 UI 挂起风险** -> 拆分后的交互逻辑可能被测试覆盖，若在测试中误触发 TTY 提问，会导致自动化测试挂起。
  * *缓解策略*：在 `terminal-interactive.ts` 询问方法内部进行 `process.stdin.isTTY` 保护，在非 TTY 自动化测试时默认直接放行，测试逻辑只需独立对提取、校验或存取规则进行 Mock 测试。
- **并发交互导致的 stdin 冲突** -> 并发调用终端命令时，多任务同时索要人工确认输入会导致 `readline` 争抢控制台输入，引发无法交互或崩溃。
  * *缓解策略*：在 `terminal-interactive.ts` 中维护一个全局 Promise 链式队列，对所有 `askUserPermission` 请求执行排队串行化。
