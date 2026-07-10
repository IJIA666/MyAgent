# 探索主题: Plan 模式只读系统命令策略

## 1. 问题定义
本次日志显示 `wmic logicaldisk where "DeviceID='C:'" get Size,FreeSpace /format:value` 在 Plan 模式下被硬拦截。该命令语义上是只读磁盘容量查询，但当前只读白名单没有覆盖，导致模型在系统状态诊断场景下被迫退化到较弱信息。

## 2. 关键发现与调研结果
- **代码库现状**：`ExecuteCommandTool.checkSafety()` 在 Plan 模式下调用 `isPlanSafeCommand()`；后者要求命令命中 shell family 对应的只读白名单且通过结构安全校验。`CMD_READONLY_WHITELIST` 当前包含 `dir`、`type`、`findstr`、`echo`、`cd`、`where` 等，不包含 `wmic logicaldisk`。
- **核实与洞察**：现行 `base-security` spec 明确要求 Plan 模式只允许可静态证明安全的系统只读查询；当前 spec 还把 `wmic logicaldisk` 作为非白名单命令被拦截的示例。若产品目标允许磁盘规划类问题在 Plan 模式收集容量信息，需要明确扩大只读白名单，而不是绕过 Plan 模式。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 A: 继续拦截所有 `wmic` | 方案 B: 仅放行受限的只读系统查询前缀 | 结论 |
| :--- | :--- | :--- | :--- |
| 安全性 | 最保守，但功能不足 | 通过前缀和结构校验限制范围 | B 在安全边界内满足需求 |
| 用户体验 | 磁盘规划无法获取容量基线 | 允许只读容量、网络、进程等基础查询逐步扩展 | B 更实用 |
| 规范一致性 | 保持现状 | 需要更新 base-security 场景 | B 需要配套 spec delta |

**推荐路径**：先只将 `wmic logicaldisk` 作为 `cmd` 下的只读白名单前缀纳入 Plan 审批路径，不泛化放行全部 `wmic`。继续禁止复合连接、重定向、环境变量展开和危险命令。

## 4. 约束、风险与未知项
- `wmic` 已在新版 Windows 中处于弱化状态，但仍常见；本次只解决现有模型已经调用的容量查询，不扩展到任意 WMI 查询。
- 只读白名单扩展必须和 `validateCommand()` 保持同构，不能出现前置允许、执行期拒绝的假阳性。

## 5. 否决方案
- **直接在 Plan 模式放行所有系统查询命令**：无法静态证明安全，会削弱 Plan 边界。
- **建议用户切 Auto/YOLO 才能查容量**：磁盘规划的第一步是只读诊断，不应要求提高权限。
