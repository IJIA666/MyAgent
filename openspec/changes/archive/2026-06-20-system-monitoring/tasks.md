# Milestone: system-monitoring

当前系统监控变更属于大任务规模，为了确保开发解耦和系统稳定性，已拆分为以下两个子变更阶段（Milestone Sub-changes）：

- [x] Sub-change: `system-monitoring-server` (Phase 1)
  - **核心目标**：构建基于 Python 的外部 MCP 监控服务端。
  - **关键特性**：使用 `pyetwkit` / `pywintrace` 进行 ETW 流量监听、通过 `ctypes` 进行 UAC 提权、在内存中进行 PID-to-Name 缓存以及多维度指标的时间窗口聚合（Time-window Aggregation）。
  
- [x] Sub-change: `system-monitoring-client` (Phase 2)
  - **核心目标**：在 IJIA Agent 客户端中集成该外部 MCP 监控服务。
  - **关键特性**：在 `mcp_config.json` 中配置并连接该服务，扩充 Agent 调用的系统性能与网络流量诊断工具，最终实现用户请求的精细化分析与报告生成。
