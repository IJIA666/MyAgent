## 背景

目前 MyAgent 在系统提示词与环境感知的设计上为纯静态设计。这虽然保证了在单会话内的前缀缓存，但是由于其缺失了 CWD、OS 版本等动态运行期参数，使得智能体经常处于“环境盲区”。而如果直接拼接高频变动的变量（如高精度时间、变化的启动路径等），则会导致缓存哈希频繁抖动和失效。

同时，自动载入本地规则时缺乏大小过滤拦截，容易引发 Token OOM；单纯在 System Prompt 中进行高危拦截规范与 lint 自测的行为约束，在大模型长上下文推理中极易被“阳奉阴违”地遗忘，无法实现高保障的工程校验。

## 目标与非目标

**目标:**
1. **单 System Message 三层 XML 缓存隔离**：在单个 System 消息内，利用 XML 隔离标记划分 `stable` (绝对静态人设)、`context` (上下文技能与本地规则) 和 `volatile` (高易变时间、cwd 牺牲层) 三层架构。既能完美应对中转代理网关的 JSON Schema 校验，又能实现核心人设在跨项目场景下的 100% 前缀缓存覆盖。
2. **本地规则安全软熔断**：在 `contextLoader.ts` 载入现有本地 `.agent/global_rules.md`、`.agent/rules/guize.md` 文件时，增加 20KB（或 5000 字符）软熔断，超出部分截断并注入标示，防止 Context Window 被超大规则打爆。
3. **只读高精度原生时间工具**：在 `toolRegistry` 中注册无副作用、只读的原生工具 `get_current_time`，供 Agent 显式调起以精确计算耗时或定位日志时间。
4. **PostRunHook 编译级硬质量校验**：任务完成写操作后，由引擎底层自动跑 lint/typecheck（如跑 eslint 和 tsc），并将报错自动反馈给 Agent，提供硬校验保证。
5. **软硬结合高危操作引擎拦截**：当检测到原生删除、覆盖工具接收到高危参数时，底层工具引擎自动强制挂起并结合 `ApprovalService` 拉起显式审批。

**非目标:**
1. **不引入多 System 消息分块传输**：避开部分中转代理网关不支持或在协议转换时丢弃多 System 消息的问题。
2. **不改变现有的规则文件目录和命名**：直接从项目现有的 `.agent/` 配置目录中读取规则，不新建自定义规则路径。
3. **不依赖 Prompt 的软指示执行高危拦截与 lint**：一切质量安全闭环全部交由执行流底层硬机制实现，提示词仅做软引导。

## 架构决策

### 决策一：单 System 消息内构建三层 XML 装配结构 (Stable-Context-Volatile)
- **实现细节**：
  - 重写 `src/brain/context.ts` 的 `SessionContext`，将原本的 `systemPrompt` 组装结构修改为物理拼接的三层 XML 标记嵌套：
    ```typescript
    const stablePrompt = BASE_SYSTEM_PROMPT; // 绝对静态的核心人设与红线
    const contextPrompt = `<context_rules>
      <available_skills>${skillsSummary}</available_skills>
      <local_rules>${loadedRules}</local_rules>
    </context_rules>`; // 工作区级温热缓存层
    const volatilePrompt = `<volatile_context>
      <date>${getCurrentDateOnly()}</date>
      <cwd>${process.cwd()}</cwd>
      <os>${process.platform}</os>
    </volatile_context>`; // 易变数据层
    ```
  - **理由**：
    - `stable` 部分处于 Token 最头部，字节绝对固定，完美匹配前缀缓存哈希。
    - 技能大纲与本地规则处于 `context` 层，在当前工作区开发期间也是高频温热的，既可以防范技能频繁更新对顶部人设缓存的击穿，又能在同一个工作区下实现缓存复用。
    - `volatile` 放于消息末尾作为牺牲层，高频变动但不破坏前面两层的前缀匹配。

### 决策二：在 `contextLoader.ts` 中引入本地规则 20KB 软熔断拦截
- **实现细节**：
  - 修改 `src/brain/contextLoader.ts` 的文件读取流程，在加载 `.agent/global_rules.md` 或 `.agent/rules/guize.md` 时，使用 `fs.statSync` 校验文件大小。
  - 若超过 20480 字节（20KB），仅使用 `fs.readSync` 截取前 20KB，并在末尾附加：`\n\n[...系统规则过长，已被安全模块截断，仅保留前20KB...]`。
- **理由**：
  - 防止开发者误操作把大日志或巨量数据保存至配置目录，从而击穿上下文上限（OOM 防护）。

### 决策三：实现 `get_current_time` 原生时间获取工具
- **实现细节**：
  - 在系统的工具类中定义 `getCurrentTimeTool` 并注册到 `toolRegistry`。
  - **Schema 定义**：无参数输入，返回 ISO 格式与本地格式的高精度时间戳。为无任何副作用的只读系统调用。
- **理由**：
  - 使 System Prompt 中只需提供天级日期以保护缓存，大模型需要精确时间时（如做两分钟前日志分析），通过 Tool Call 直接按需获取。

### 决策四：PostRunHook 与底层操作硬拦截（软硬结合）
- **实现细节**：
  - **PostRunHook**：在 Agent 发送最后一轮响应或任务写操作完毕后，执行流底层自动执行 `npm run lint` 和单元测试自测校验，并将发生的报错输出作为反馈再次注入到会话历史中。
  - **高危硬拦截**：在工具引擎层（Tool Execution Engine）对高危动作进行关键字或参数匹配。凡是原生文件删除或覆盖等操作涉及高危动作时，引擎直接触发 `ApprovalService` 挂起执行流，等待用户显式确认后才能继续，实现底层硬拦截。
- **理由**：
  - 防止模型在长上下文中逻辑退化而选择“遗忘”或“阳奉阴违”直接执行危险操作，提供物理级的安全保障。

## 风险与权衡

- **[风险点：中转代理网关丢弃 XML 标签]** -> **[缓解策略]**：XML 标签仅作为内容字符串的一部分嵌套在单条 system 消息内，不会被任何符合 OpenAI 标准的 API 中断或过滤。
- **[风险点：大模型“阳奉阴违”忽略软规则，未主动执行 lint 或暂停高危操作]** -> **[缓解策略]**：通过底层的 `PostRunHook` 在任务结束后由系统自动代为跑 lint/typecheck 并重试，同时在高危工具底层建立结合 `ApprovalService` 的拦截流强行挂起，用物理机制封堵 Prompt 的不确定性。
- **[风险点：超大规则文件触发熔断后丢失了关键指令]** -> **[缓解策略]**：截断后在末尾附加醒目的截断标志，这会作为提示词输入给模型，模型将感知到“规则已被截断”并能主动向用户汇报此异常情况。
