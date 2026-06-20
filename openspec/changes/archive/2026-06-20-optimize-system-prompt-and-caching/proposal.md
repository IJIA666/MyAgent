## 改造原因

目前 MyAgent 项目在系统提示词、环境感知与缓存策略上存在以下问题与安全隐患：
1. **环境上下文缺失（环境盲区）**：目前的 System Prompt 属于纯静态设计，无法动态感知当前工作路径（CWD）、时间戳、系统平台等必要运行期上下文，极易造成模型在定位文件、调用工具或解析时区时决策失误。
2. **前缀缓存（Prompt Caching）频繁失效**：若不进行合理的动静层级隔离，将频繁变动的动态环境信息（如分秒级时间、瞬时 CWD）与大段的静态核心人设直接拼接，会导致在会话重开、工作区切换或同一天内反复请求时，前缀缓存哈希抖动击穿，极大地增加了 Token 消耗并降低了响应速度。
3. **缺少 Token 防爆防御机制（OOM 风险）**：自动载入本地 `.agent/` 规则文件时缺乏大小检测，一旦误导入超大日志或冗长代码规范，极易撑爆模型的 Context Window 导致全局变砖崩溃。
4. **高危拦截与工程自测缺乏硬约束**：单纯依靠 System Prompt 的“行为软引导”要求模型在删除文件或完成任务后自测 lint 极其脆弱，在长上下文中极易发生模型“遗忘”或“阳奉阴违”漏执行，缺乏底层的硬性安全拦截与自动化自测钩子校验。

## 变更内容

本变更拟对系统提示词装配、缓存管理与引擎拦截策略进行全面重构：
1. **System Prompt 单消息三层动静隔离架构（适配 OpenAI 前缀缓存）**：
   - 维持单 System 消息的物理形式以保障最高的中转网关兼容性，在单个消息内通过 XML 标签划分三个层级：
     - `stable` (稳定人设层)：核心 Persona 与工程红线，绝对静态，跨会话/工作区 100% 缓存共享。
     - `context` (上下文环境层)：包含全局技能大纲 `<available_skills>` 和本地规则 `<context_rules>`。仅在工作区变动或技能更新时失效，保障单工作区内的长期温热缓存。
     - `volatile` (易变层)：包括天级日期 `Date`、工作路径 `cwd`、系统平台等，置于消息尾部作为牺牲层，高频变化但不影响前面两层的缓存哈希匹配。
2. **Token OOM 软熔断防御**：
   - 在 `contextLoader.ts` 中针对本地加载规则加入 20KB（或 5000 字符）阈值熔断机制，超出则自动截断并拼入截断标志语，从底层保护系统可用性。
   - 弃用多余的自定义规则路径发现映射，保持直接沿用项目现有的 `.agent/` 规则体系。
3. **只读原生时间工具注册**：
   - 新增只读、无副作用的原生高精度时间获取工具 `get_current_time`，并注册于 `toolRegistry` 中。配合 System Prompt 的“天级”粗粒度时间戳，提供按需分秒级时间诊断感知能力。
4. **Lint 编译级 PostRunHook 强校验（工程硬校验）**：
   - 在引擎底层引入 PostRunHook 机制。在一轮任务写操作完成后，系统代码底层自动调起本地的 lint/typecheck，捕获报错并反馈给模型进行自我修复。
5. **软硬结合高危操作引擎拦截**：
   - 引擎层在检测到原生工具（如文件删除、重置）收到高危参数时，强制结合系统原有的 `ApprovalService` 挂起执行流，并拉起显式审批。

## 业务能力

### 新增业务能力
- `get-current-time`: 提供只读、无副作用的原生高精度系统时间获取工具，并注册到系统的 `toolRegistry` 中，供大模型运行时通过 Tool Call 显式调起，实现精准的时间差计算与日志定位。

### 修改业务能力
- 无

## 影响范围

1. **`src/brain/context.ts` (SessionContext)**：
   - 重构单 System Message 组装结构，构建 stable/context/volatile 三层 XML 装配体系。
2. **`src/brain/contextLoader.ts` (ContextLoader)**：
   - 在加载现有 `.agent/global_rules.md`、`.agent/rules/guize.md` 规则文件的流程中，增加单文件 20KB 软熔断拦截。
3. **`src/brain/prompts/prompts.ts`**：
   - 重构 `BASE_SYSTEM_PROMPT`，加入最小重构、TSDoc 严格规范、专用工具优先、命令原子化等核心红线。
4. **系统工具链与 Tool 注册器**：
   - 注册并公开 `get_current_time` 只读时间获取工具。
5. **执行流管理层 (Tool Execution Engine)**：
   - 实现 PostRunHook 自测钩子机制（在任务写完后自动跑 lint/typecheck 反馈模型）。
   - 实现高危参数的引擎级拦截，强制结合 `ApprovalService` Suspend 执行。
