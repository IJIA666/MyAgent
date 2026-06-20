## 改造原因

目前 IJIA Agent 缺乏对 Windows 系统的细粒度资源监控和网络带宽分析能力。为了能够帮助用户实现更深度的系统性能诊断、网络偷跑流量监测和进程活动分析，需要构建一个精细化监控底层数据采集系统。由于此类操作在 Windows 下涉及微秒级的 ETW (Event Tracing for Windows) 事件追踪以及高精度的系统性能计数器获取，采用 Python 开发外部 MCP 服务端是最为敏捷、高效且隔离性最好的方案。

## 变更内容

本变更将引入基于 Python 编写的外部系统监控服务（MCP Server）。主要变化如下：
1. 构建基于 `pyetwkit` / `pywintrace` 的 ETW 流量追踪引擎，获取微秒级的网络包事件（包含 IP, 端口, PID 以及字节数）。
2. 构建基于 `Microsoft-Windows-Kernel-Process` 事件的进程生命周期监听器，并在内存中维护 PID 到进程名的 LRU 缓存，以准确关联瞬发进程。
3. 实现时间窗口聚合（Time-window Aggregation）算法，周期性统计各进程的瞬时上传/下载速率，对外仅提供聚合后的精炼 JSON 报告，防止 Token 爆炸。
4. 封装符合 Model Context Protocol (MCP) 规范的 Stdio/HTTP 接口，向 Agent 客户端暴露系统监控和分析工具。
5. 设计 Windows UAC 自动提权逻辑，在检测到权限不足时自动拉起管理员权限弹窗，避免冷启动静默崩溃。

## 业务能力

### 新增业务能力
- `windows-monitoring-server`: 提供 Windows 系统精细化资源与网络流量数据监听和诊断的外部 MCP 服务能力。

### 修改业务能力
