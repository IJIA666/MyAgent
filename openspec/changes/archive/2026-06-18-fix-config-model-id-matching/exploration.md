# 探索主题: 配置文件中模型名称后缀导致加载器匹配内置ID崩溃问题

## 1. 问题定义
在用户环境执行 `npm run dev` 启动项目时，系统抛出致命错误崩溃：
`Error: 未知的模型 ID: deepseek-v4-flash[1m]`
核心痛点在于系统把配置在 `.env` 中带后缀的模型参数 `DEEPSEEK_MODEL`（其值默认为 `deepseek-v4-flash[1m]`）直接当作内置模型 ID 去匹配 `BUILTIN_MODELS` 的 Key。由于 Key 中并不包含 `[1m]` 等窗口尺寸后缀，导致配置加载器静态匹配失败。

同时，作为一个辅助的用户体验优化项，用户希望在系统成功启动后的配置面板（Banner）中，能够直观地看到当前激活的大语言模型所匹配的**上下文总大小限制**（例如通过 `.env` 中的 `[1m]` 自动解析得到的 `1,000,000 tokens` 限制），以方便开发调试。

## 2. 关键发现与调研结果
- **代码库现状**：
  - 在 `src/config/loader.ts` 第 83 行：
    ```typescript
    const defaultModelId = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
    const llm = getModelConfig(defaultModelId);
    ```
    加载器在初始化时直接读取了 `.env` 中配置的 `DEEPSEEK_MODEL` 作为 `defaultModelId`。
  - 在 `src/config/models.ts` 中定义的内置模型键只有 `deepseek-v4-flash` 和 `deepseek-v4-pro`。由于未剥离 `[1m]` 后缀，`getModelConfig(id)` 执行到 `BUILTIN_MODELS[id]` 时无法命中并抛出 `未知的模型 ID` 崩溃异常。
  - **环境差异成因**：在开发机使用 AI 终端执行测试时，父进程已隐式注入了 `DEEPSEEK_MODEL=deepseek-v4-flash` 环境变量。由于 `dotenv` 不覆写已存在的环境变量，导致 AI 环境下启动没有触发此报错。而在用户的原生终端下，由于无父进程的环境变量注入，直接读取了 `.env` 中带有 `[1m]` 后缀的配置，从而导致直接崩溃。

- **Claude Code 对标调研**：
  - 经深入 `d:/Projects/Agents/claude-code/src` 源码发现，Claude Code 对第三方或自定义模型提供类似 `[1m]` 的标签支持。
  - 在 `utils/model/modelOptions.ts` 中，`is1m = has1mContext(...)` 会检测模型名中是否带有此类后缀，以在本地 TUI 和成本计算中标记为“1M Context”版本。
  - 核心剥离机制存在于 `utils/model/model.ts` 第 616-618 行的 `normalizeModelStringForAPI` 函数中：
    ```typescript
    export function normalizeModelStringForAPI(model: string): string {
      return model.replace(/\[(1|2)m\]/gi, '')
    }
    ```
    即：**在真正发起 API 调用时，客户端会自动剥除后缀，以标准的纯模型名称向平台请求**。这证实了在 `.env` 中写 `[1m]` 是为了本地提供上下文大小指引，而在调用 API 阶段剥离是一种成熟的做法。

- **DeepSeek 官方 API 核实**：
  - 通过联网检索，DeepSeek 官方 API（主干模型 `deepseek-v4-flash`、`deepseek-v4-pro`）使用 OpenAI 兼容的标准格式，其 `model` 字段**不接受任何携带中括号的非标准后缀**（如直接传 `deepseek-v4-flash[1m]` 会导致 API 端报 400 模型不存在错误）。
  - 这进一步证明我们本地代码的“从 API 参数中剥离后缀”是极其必要的，但本地的“配置加载预匹配”也必须在查询本地 Profile 字典时忽略这个后缀。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 A：在 `loader.ts` 解析模型 ID 时正则剥离后缀 | 方案 B：在 `models.ts` 的 `getModelConfig` 内部容错 | 方案 C：修改 `.env` 配置文件契约，分离 ID 与名称 | 结论 |
| :--- | :--- | :--- | :--- | :--- |
| **兼容性** | 无痛兼容现有 `.env` 配置，完全符合 Claude Code 的设计初衷 ✓ | 会使 ID 参数语义泛化，破坏强类型接口严谨性 ✗ | 需要用户手动迁移配置，属于破坏性变更 ✗ | 方案 A 占优 |
| **影响范围** | 仅修改 `loader.ts` 初始化提取逻辑，非常聚焦 ✓ | 需要修改 `models.ts` 查找映射机制 ✗ | 影响全局 `.env` 与示例文件 ✗ | 方案 A 占优 |
| **优雅性** | 完美对齐 Claude Code 对 `[1m]` 作为标饰后缀的生命周期剥离设计 ✓ | 接口行为变得模糊 ✗ | 增加了用户维护环境门槛 ✗ | 方案 A 占优 |

**推荐路径**：
使用 **方案 A**。在 `src/config/loader.ts` 获取 `defaultModelId` 的步骤中，主动利用正则剥离其可能携带的类似 `[1m]`、`[128k]` 后缀，还原成干净的内置模型 ID 再进行配置工厂匹配：
```typescript
  // 3. 必填环境变量校验（fail-fast）
  const rawModelId = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
  // 自动剔除可能携带的尺寸后缀（如 [1m]、[128k] 等）得到正确的内置模型 ID
  const defaultModelId = rawModelId.replace(/\[\d+[km]\]/i, '');
  const llm = getModelConfig(defaultModelId);
```

此外，结合优化需求，将在启动欢迎日志中直观输出当前上下文窗口大小限制。具体改动位于 `src/index.ts` 中的启动 banner 部分，追加输出当前激活配置的 `llm.contextWindow` 大小：
```typescript
  // 3. 打印系统启动与配置信息
  const banner = `====================================================
[系统] IJIA Agent 启动完成
[配置] 授权工作区目录：${appConfig.workspace}
[配置] 模型：${appConfig.llm.model}
[配置] 上下文窗口限制：${appConfig.llm.contextWindow.toLocaleString()} tokens
[配置] 接口端点：${appConfig.llm.baseUrl}
====================================================`;
```

并且，为了让用户随时能在输入提示符上直观监控上下文总大小，我们在 `src/brain/session.ts` 的 `getModelName()` 逻辑中，根据 `llmConfig.contextWindow` 动态换算并追加 `[1m]` 或 `[128k]` 的后缀标饰：
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
这保证了交互提示符能够显示为诸如 `用户 [deepseek-v4-flash[1m]] >` 这种携带大小标识的格式。

## 4. 约束、风险与未知项
- **风险**：需要确保正则表达式 `/\[\d+[km]\]/i` 能够百分之百覆盖所有可能配置的窗口后缀，避免漏剔除。经核实，系统在 `models.ts` 中使用的是 `/\[(\d+)([km])\]/i`，因此剥离正则与之完美同步。

## 5. 否决方案
- **方案 C（修改 `.env` 契约）**：这会引入多余的环境变量配置项（如新增 `DEEPSEEK_MODEL_ID`），不仅会增加用户的上手和维护门槛，而且与现有的设计规范产生偏离，故予以否决。
