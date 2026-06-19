## 修改需求

### 需求: 大模型与网络参数配置化管理
系统必须支持将每个内置大模型的上下文窗口（Context Window）以及调用选项（如采样温度、超时限制、最大重试次数、自定义请求头）在配置层进行声明，且必须提供通过通用环境变量覆写整个模型配置（包括 API 端点、实际调用模型名称、上下文窗口大小、温度、超时、重试及请求头）的能力，以实现 Claude Code 式的高度可扩展性。

#### 场景: 模型最大窗口与调用选项配置化
- **WHEN** 载入大模型连接配置时
- **THEN** 系统必须将各内置模型（如 `deepseek-v4-flash`）的上下文窗口属性（`contextWindow`）、温度（`temperature`）、重试次数（`maxRetries`）、超时时间（`timeout`）及自定义请求头（`headers`）写入其 `ModelProfile` 档案；在执行自适应 Token 压缩时，系统必须基于此配置中的 `contextWindow` 属性（而非硬编码名字判定）计算触发水位。

#### 场景: Claude Code 式模型与网络配置环境变量覆写
- **WHEN** 从 `BUILTIN_MODELS` 工厂解析模型连接配置（`getModelConfig`）时
- **THEN** 系统必须支持通过 `process.env` 进行动态覆写：
  1. 支持通过 `process.env.AGENT_LLM_MODEL`（或对应的其他模型覆写变量）动态改写最终发送给 API 的模型标识符名称，允许使用第三方兼容端点。同时，系统必须支持匹配并自动剥除模型名中的 `[1m]`、`[128k]` 等窗口后缀（以防第三方 API 接收到带后缀的模型名发生校验报错），并将解析出来的物理窗口大小在系统内自适应应用；
  2. 支持通过 `process.env.AGENT_LLM_CONTEXT_WINDOW` 动态覆写上下文物理窗口大小，系统必须支持对其指定的文本缩写（如 `1m` / `1M` 代表 1000000；`128k` / `128K` 代表 128000）进行解析还原。如果检测到模型名称被覆写但缺失窗口环境变量及后缀匹配时，系统必须自动将其退化至保守的上下文物理窗口限制（32k，即 32000 tokens）以防由于第三方小模型限制而导致溢出；
  3. 支持通过 `process.env.AGENT_LLM_TEMPERATURE` 动态覆写采样温度；
  4. 支持通过 `process.env.AGENT_LLM_TIMEOUT`（毫秒）动态覆写网络超时限制；
  5. 支持通过 `process.env.AGENT_LLM_MAX_RETRIES` 动态覆写网络请求的最大重试次数；
  6. 支持通过 `process.env.AGENT_LLM_HEADERS`（以换行符或分号分隔的名值对）动态覆写并解析为自定义 HTTP 请求头合并注入。
