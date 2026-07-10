# 探索主题: 终端命令告警解析与 Windows 参数误判

## 1. 问题定义
`dir C:\ /A:H /W` 的工具结果中出现了 `A:\H`、`D:\W` 之类跨盘或越界告警。`/A:H` 和 `/W` 是 `cmd dir` 的开关参数，不是路径。误报会误导模型判断存在越界访问，并污染 `<shell_metadata>`。

## 2. 关键发现与调研结果
- **代码库现状**：`detectAdvisoryWarnings()` 对 `unboxNestedCommand(command).split(/\s+/)` 的每个参数做路径启发式判断；在 Windows 上，`path.isAbsolute('/A:H')` 或后续 `resolve` 语义可能将 cmd 风格开关解释成当前盘根路径，进而产生虚假的跨盘/工作区外访问告警。
- **核实与洞察**：本次日志里的告警正对应 `dir C:\ /A:H /W` 的两个开关。真实外部访问只有 `C:\`，`A:\H` 和 `D:\W` 都是解析器制造出来的假路径。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 A: 禁用 advisory warnings | 方案 B: 按 shell family 跳过开关参数 | 结论 |
| :--- | :--- | :--- | :--- |
| 安全提示保留 | 丢失所有潜在越界提示 | 保留真实路径提示 | B 更合理 |
| 实现复杂度 | 很低 | 需要传入或推断 shellKind | B 复杂度可接受 |
| Windows 适配 | 规避误报但损失能力 | 直接修复 `/A:H`、`/W` 误判 | B 更准确 |

**推荐路径**：让 `detectAdvisoryWarnings()` 接收已决议的 shell family，并在 `cmd` 下跳过 `/` 开头的开关参数，在 PowerShell 下跳过 `-` 开头的参数，在 POSIX 下跳过普通 option；只对明确绝对路径或带盘符路径做越界提示。

## 4. 约束、风险与未知项
- 不能跳过 `/absolute/path` 这类 POSIX 绝对路径；跳过规则必须结合 shell family。
- 不能用简单字符串替换清洗命令，路径判断仍应复用现有真实路径解析边界。

## 5. 否决方案
- **仅过滤 `/A:H` 和 `/W` 特例**：无法覆盖其他 cmd 开关。
- **把所有以 `/` 开头的参数都当成非路径**：会误放 POSIX 绝对路径，必须按 shell family 区分。
