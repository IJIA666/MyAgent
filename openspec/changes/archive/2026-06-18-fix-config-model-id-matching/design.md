## 背景

在大模型开发工具的设计中，诸如 `Claude Code` 广泛允许用户在配置文件中使用带有 `[1m]` 等窗口尺寸后缀的模型名称。系统可在本地识别该窗口大小并提供剪枝策略、成本计算以及在控制台界面展示上下文限额标识。

在本项目中，实际网络通信发送模型时已经实现了对该后缀的剔除。然而，系统在启动时的预加载校验阶段（`loader.ts`）却将带有后缀的值直接当成模型 ID 进行匹配检索，引发了 `未知的模型 ID` 崩溃。同时，当前的 REPL 输入提示符中缺少对上下文大小的可视化标签（如用户所希望显示的 `用户 [deepseek-v4-flash[1m]] >`）。

## 目标与非目标

**目标:**
- 在 `loader.ts` 解析模型环境变量后、检索内置模型 ID 前，用正则剔除可能包含的窗口后缀，以让系统能够在原生 shell 环境下安全通过预检启动。
- 优化 `src/index.ts` 启动 Banner 日志，增加 `llm.contextWindow` 上下文总 tokens 大小的格式化输出。
- 重构 `src/brain/session.ts` 的 `getModelName()` 函数，读取上下文窗口大小值并动态拼接 `[1m]` 或 `[128k]` 等窗口后缀。这使得诸如交互行提示符等终端视图能够直观动态显示限额后缀。

**非目标:**
- 不修改 `models.ts` 的 `getModelConfig` 的强类型模型 ID 参数语义，不在其内部做模型 ID 参数的模糊容错。
- 不影响大模型底层请求中对于实际模型参数名称的最终输出（它已经过后缀剥离过滤）。

## 架构决策

- **决策一：预加载阶段在获取 ID 前正则剥除窗口后缀**
  - **实现逻辑**：
    在 `src/config/loader.ts` 中，获取 `defaultModelId` 的代码：
    ```typescript
    const rawModelId = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
    const defaultModelId = rawModelId.replace(/\[\d+[km]\]/i, '');
    const llm = getModelConfig(defaultModelId);
    ```
  - **理由**：
    在配置最外层对后缀进行擦除，能完美兼容本地 `.env` 的优良配置，且避免了将带有后缀的字符串作为参数传入强类型的配置工厂方法，确保代码层级的责任边界清晰。

- **决策二：启动欢迎日志输出上下文总大小限制**
  - **实现逻辑**：
    修改 `src/index.ts` 的 `banner` 逻辑，在输出中注入格式化的 `appConfig.llm.contextWindow` 数值：
    ```typescript
    [配置] 上下文窗口限制：${appConfig.llm.contextWindow.toLocaleString()} tokens
    ```

- **决策三：交互提示符中根据 Context Window 数值换算拼接窗口大小后缀**
  - **实现逻辑**：
    重构 `src/brain/session.ts` 的 `getModelName()`，利用已解析的 `this.llmConfig.contextWindow`（即数字）：
    ```typescript
    public getModelName(): string {
      const baseName = this.driver.getModelName();
      const window = this.llmConfig.contextWindow;
      if (window) {
        if (window >= 1000000) {
          return `${baseName}[${Math.round(window / 1000000)}m]`;
        } else if (window >= 1000) {
          return `${baseName}[${Math.round(window / 1000)}k]`;
        }
      }
      return baseName;
    }
    ```
  - **理由**：
    这在交互提示符和重绘时都使用此带有后缀的名词渲染。在数据模型层面仅保存纯净的模型名，而在与交互有关的门面获取层（`getModelName`）上做格式化拼接，既简单高效，又能百分之百支持用户在 REPL 提示符动态监控上下文限制的体验优化。

## 风险与权衡

- **风险点**：正则剥除规则可能和实际配置有轻微偏差。
- **缓解策略**：经比对，`models.ts` 底层剥离使用的是 `/\[(\d+)([km])\]/i`，我们在加载器和换算处与之保持完全的一致性（支持万能匹配 `k`, `m` 以及大小写），没有不兼容风险。
