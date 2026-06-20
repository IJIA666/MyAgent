## 改造原因

在 Phase 1 中，我们已经成功搭建了运行于 Windows 环境下的高精度系统性能与流量监控 MCP 服务端（`monitoring_server`）。为了将这些精细化工具（网络吞吐速率、内核池泄露、CPU 争抢与句柄泄露）开放给 IJIA Agent 使用，我们需要在 Agent 客户端（Node.js 进程）集成并配置该 Stdio 传输通道，处理进程的冷启动和特权缺失崩溃报错，并使 Agent 具备调用和呈现系统运行分析报告的能力。

## 变更内容

本变更将修改 IJIA Agent 客户端，主要改动如下：
1. **MCP 服务端配置注册**：在系统配置文件（如 `mcp_config.json`）中注册 `monitoring-server` 服务端，配置其 Stdio 启动命令（如 `uv --directory monitoring_server run python main.py`）。
2. **管理员权限缺失优雅报错拦截**：当 Agent 启动该 Stdio MCP 进程时，若因为未管理员提权导致服务端 Fail-Fast 崩溃（Exit Code 1），Agent 必须能够捕获其 `sys.stderr` 报错，并输出醒目提示，引导用户“以管理员身份重新运行 PowerShell 终端拉起 IJIA Agent”。
3. **系统状态诊断报告生成**：扩展 Agent 调用的系统运行状态和带宽偷跑分析功能，支持将获取的 JSON 聚合数据解析并生成精细的运行状态诊断总结。

## 业务能力

### 新增业务能力
- `system-monitoring-client`: 在 IJIA Agent 客户端中配置、冷启动并连接外部系统监控 MCP 服务，提供对底层硬件性能与瞬时网络带宽的诊断和报告生成能力。

### 修改业务能力
<!-- 无修改的既有业务能力 -->
