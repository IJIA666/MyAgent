# 探索主题: 工作模式快捷切换指令 `/workmode` 的集成与同步

## 1. 问题定义
在当前的双轨安全防御机制中，系统虽然已经实现了 `Plan` 模式下的物理工具裁剪和提醒气泡注入，但在交互控制台（CLI）中却遗漏了实时修改安全工作模式的交互手段。用户目前必须修改环境变量并重启，这极大地妨碍了开发期的调试与安全拦截体验。我们迫切需要在控制台交互层添加一个 `/workmode` 斜杠指令，支持在 YOLO, Auto, Safe 和 Plan 之间灵活切换。

## 2. 关键发现与调研结果
- **代码库现状（级联受灾区）**：
  - 经深入排查 [help.ts](file:///d:/projects/MyAgent/src/adapters/input/interface/commands/help.ts)，所有指令提示均为静态硬编码打印。添加 `/workmode` 时必须级联更新此文件。
  - **`/model` 参数描述偏差**：在 `help.ts` 中将模型切换指令列为 `/model <id>`，暗示 `id` 为必填参数；然而查阅 `ModelCommand` 实现发现，空参时会自动启用 Clack 模型切换与推理 effort 确认向导。此处帮助提示应更正为可选参数 `/model [id]` 避免误导。
  - 经深入排查 [command.ts](file:///d:/projects/MyAgent/src/adapters/input/interface/command.ts)，双击键入 `/` 后展示的快捷 Clack 选择菜单同样属于硬编码定义。若要在图形菜单中支持此动作，必须在 `showInteractiveMenu` 的 `options` 及判定过滤数组中补上 `'workmode'` 标号。
  - **`CommandRegistry` 命令注册表与导出遗漏（新增点）**：
    1. 在 `command.ts` 的 `CommandRegistry` 构造方法中，必须追加 `this.register(new WorkModeCommand())` 以便分发器识别。
    2. 在命令包索引 [index.ts](file:///d:/projects/MyAgent/src/adapters/input/interface/commands/index.ts) 中，必须追加对新类 `WorkModeCommand` 的物理重导出。
- **状态一致性核实**：
  - 底层的安全控制是通过双重状态获取的：一部分是会话上下文私有的 `SessionContext.getWorkMode()`，一部分是系统终端工具在无 context 时的全局兜底 `terminal-config.ts` 中的全局变量。我们的命令执行体必须**同步更新这两处状态**，否则会导致前端安全判定（如 YOLO 是否放行）与大模型提示词注入（气泡中的安全模式）状态脱节。

## 3. 方案对比与推荐方向

| 评估维度 | 方案 A: 经典级联修补（推荐） | 方案 B: 动态命令反射与自动菜单 |
| :--- | :--- | :--- |
| **开发成本** | 极低 ✓ (直接在现存硬编码处进行行级补全) | 高 ✗ (需完全重构 ICommand 及 facade.ts) |
| **稳定与测试风险**| 无 ✓ (延续现存 CLI 交互模式) | 较高 ✗ (极易引起 CliFacade 与 command 测试用例破坏) |
| **代码可读性** | 中 ✗ (受制于既有硬编码，稍微有一点冗余) | 极高 ✓ (真正解耦命令与 UI 展现) |

**推荐路径**：采用 **方案 A**。这非常适合小项目快速敏捷地在单处迭代完成交付，既对历史测试零冲击，又能最大化保证与现存命令行交互规范的完美对齐。

## 4. 约束、风险与未知项
- **忙碌锁异常**：`SessionContext.setWorkMode()` 在会话处于 `isProcessing = true`（LLM 逻辑轮转中）时修改状态会直接抛出 busy 异常。但由于命令行交互指令只有在智能体空闲等待 Stdin 输入时才能触发（此时 `isProcessing` 必然为 `false`），因此这在实际上是安全的，没有越权并发风险。

## 5. 否决方案
- **方案 B（动态命令反射重构）**：虽然架构解耦更加理想，但这并非本次 change 的核心业务目标。重构 CLI 底座会产生大量无用代码 churn，且对已有回归测试破坏性过强，予以坚决否决。
