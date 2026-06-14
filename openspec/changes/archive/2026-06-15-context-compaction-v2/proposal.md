## 改造原因

现有的上下文压缩方案（如接近 Token 上限时触发同步阻塞式提炼历史）存在两个致命问题：一是会导致主线程严重阻塞，出现长达数十秒的界面假死，体验极差；二是单纯的 LLM 总结极易导致关键标识符（如 UUID、绝对文件路径）丢失或被压缩扭曲，造成后续工具调用报错甚至业务断链。为了构建生产级、高可用的 Agent，必须对 Context Compaction 进行彻底的架构升级。

## 变更内容

本次更新将重构现有的上下文管理机制，引入“无感后台提炼”与“三重复合护栏”架构：
1. 抛弃同步阻塞模式，改为基于后置钩子（Post-Turn Hook）在后台异步、定期地生成和更新 Session Summary，爆仓时瞬间完成零延迟截断。
2. 引入带 Token 预算的文件重载（File Pinning），对修改中的文件内容及核心 UUID 做硬拼接式无损恢复。
3. 增加严格标识符保护协议（Strict Identifier Preservation）及交接班指令（Handoff Instructions），防止语义变砖。
4. 增加本地静态代码级的防崩溃兜底（Deterministic Fallback），以防模型接口故障导致无限重试死锁。

## 业务能力

### 新增业务能力
- `context-compaction-v2`: 基于异步后台提炼与三重复合护栏的下一代上下文截断与防爆仓能力。

### 修改业务能力

## 影响范围

- 上下文追踪模块（History Manager）：引入基于指针的截断（保持物理日志连续不轮换）。
- 大模型请求模块（LLM Service）：新增异步后台跑批能力（或引入 Worker 多线程分担 Token 计算）。
- 提示词生成流水线（Prompt Builder）：需固化 System Prefix 注入机制，支持文件动态重载和兜底注入。
