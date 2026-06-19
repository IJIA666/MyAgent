## 背景

在当前项目中，系统的两大基础模块——“会话状态管理”与“全局配置加载”深度纠缠了磁盘 IO 副作用与全局状态。`SessionContext` 同时充当了数据容器、文件读取器与安全控制者，这颠倒了数据与仓储的调用顺序；配置加载器 `loadConfig` 糅合了文件物理拷贝与隐式全局变量读取，极大地破坏了可测试性与测试用例之间的环境隔离。

为了让系统更加内聚、稳健，我们需要在本期重构中对其进行底层的模块化拆分。

## 目标与非目标

**目标:**
1. **状态与持久化彻底解耦**：将 `SessionContext` 的所有文件物理读写操作移除，使其专注于纯内存会话状态维护。
2. **仓储与安全职责分离**：下沉落盘逻辑至 `ContextRepository`；建立独立的全局单例 `SecurityService` 统一管理安全命令白名单。
3. **配置加载器依赖注入改造**：移除 `loadConfig` 内部的磁盘拷贝副作用；支持显式传入环境变量对象 `env` 进行依赖注入，消除单元测试中的全局变量污染。

**非目标:**
1. **不修改核心推理流**：坚决不对 `AgentLoop` 的 `chat` 推理大循环内部的 Hook 调用、Stream 处理及控制流骨架做破坏性拆分（留待第二期优化）。
2. **不统一工具分派通路**：坚决不对 `ToolRegistry` 中对本地 Native 工具/MCP 工具的大 switch-case 分发硬编码执行重构（留待第二期优化）。
3. **不调整基础依赖**：不改动大模型 SDK、MCP SDK、Immer 等核心库的版本和交互契约。

## 架构决策

### 决策 1：仓储模式 (Repository Pattern) 替代活动记录 (Active Record) 模式
* **做法**：原本 `SessionContext` 管理自身的 `saveState/loadState` 文件 IO 操作。重构后，由 `ContextRepository` 直接操作 `SessionContext` 的数据并完成物理文件持久化与加载恢复。
* **原因**：实现内存状态实体与持久化媒介的完全物理隔离。在后续编写单元测试或引入其他持久化介质（如数据库）时，核心状态类不需要进行任何代码改动。

### 决策 2：依赖注入 (Dependency Injection) 消除全局环境强耦合
* **做法**：`loadConfig()` 函数签名改造为 `loadConfig(env?: Record<string, string | undefined>)`，内部所有对 process.env 的读取均路由到传入的 `env` 局部变量上。
* **原因**：测试用例（如 `loader.test.ts`）可以注入定制的 Mock 环境变量子集，在不污染物理 process.env 和不需要注入无关的 `DEEPSEEK_API_KEY` 的前提下，实现局部零件的 100% 隔离单测。

### 决策 3：独立 SecurityService 接管命令安全白名单
* **做法**：构建一个独立的全局单例 `SecurityService` 专门管理 `.agent/allowed_commands.json` 的读写。
* **原因**：剥离单次会话状态（`SessionContext`）与全局/系统级别安全安全规则的边界冲突，防止因为单次会话重建而导致安全策略重新热加载。

## 风险与权衡

### 风险 1：会话恢复数据格式向下不兼容
* **描述**：由于 `SessionContext` 结构去除了白名单属性，旧版落盘的 json 会话恢复时可能会导致解析故障。
* **权衡**：基于用户对“无需顾虑历史遗留 compatibility”的明确授权，我们将直接采用新版简化的序列化格式。同时，在 `ContextRepository` 的加载流程中做好降级防护，若字段缺失则自动注入安全默认状态，以防进程崩溃。

### 风险 2：配置拷贝逻辑移出导致测试/启动漏调
* **描述**：`ensureConfigFiles()` 被移出 `loadConfig()`，如果新入口漏调，可能会在缺少 `.env` 时导致运行时故障。
* **权衡**：在核心主入口 `src/index.ts` 的第一行前置显式调用 `ensureConfigFiles()`。而在 `loadConfig()` 阶段，若本地确实缺少配置文件，解析器会自动通过环境变量默认值及优雅的回退策略进行降级防护，保障单测的自给自足。
