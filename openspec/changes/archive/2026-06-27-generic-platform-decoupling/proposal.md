## 改造原因

核心在于重构治理智能体平台环境特化硬编码的技术债务：
1. **解决核心提示词平台冲突**：解决 `prompts.ts` 核心静态人设 `BASE_SYSTEM_PROMPT` 中硬编码 Windows 系统规则，与 volatile 层动态探测当前宿主操作系统类型（macOS/Linux 等）而产生的模型认知分裂问题。
2. **释放大批量嵌入并发吞吐**：精炼领域服务 `MemoryService.ts`，下沉 DashScope 独有的批大小（10）物理限制，充分榨干 OpenAI 等高吞吐嵌入提供商的并发性能。
3. **净化核心进程调度底座**：剥离终端调度引擎 `terminal-engine.ts` 中针对 win32 物理宿主的特异性漏洞补救，下沉至操作系统适配器中。

## 变更内容

1. **冷人设占位符化与模块级自适应装配**：
   - 剥离静态 `BASE_SYSTEM_PROMPT` 里的 Windows 指令，改为 `{{OS_SECURITY_INSTRUCTIONS}}`。
   - 新增平台特定安全性指令常亮映射 `OS_INSTRUCTIONS_MAP`（支持 win32、darwin 和 linux）。
   - 在 `prompts.ts` 模块初始化加载时，自适应替换占位符并固化为 `RESOLVED_BASE_PROMPT` 常量作为 stable 层内容，在会话生命周期内绝对静态，保持 100% 缓存命中。
2. **拆批机制完全下沉**：
   - 清除领域层 `MemoryService.ts` 的批分块逻辑与 `BATCH_SIZE = 10` 常量，改由 `EmbeddingPort` 具体提供商适配器层自理。
   - 在 `DashScopeEmbeddingAdapter.ts` 内部封装批分发并发，使领域服务保持平台及提供商无关的纯净性。
3. **无状态终端引擎特异性解耦**：
   - 将 powershell 的 chcp 控制及 npm-cli 劫持修补逻辑移出进程调度底座。

## 业务能力

### 新增业务能力
- 无 （本次为纯内部技术解耦和架构治理，不引入任何新增业务规格）

### 修改业务能力
- 无 （本次不破坏既有的业务行为，仅为内部依赖的依赖反转与重构）

## 影响范围

- **受影响代码**：
  - [prompts.ts](file:///d:/projects/MyAgent/src/core/usecases/prompts.ts) (人设重构)
  - [MemoryService.ts](file:///d:/projects/MyAgent/src/core/usecases/MemoryService.ts) (下沉批逻辑)
  - [DashScopeEmbeddingAdapter.ts](file:///d:/projects/MyAgent/src/adapters/llm/DashScopeEmbeddingAdapter.ts) (适配器接管分批)
  - [terminal-engine.ts](file:///d:/projects/MyAgent/src/adapters/tools/tools/system/terminal-engine.ts) (宿主解耦)
- **受影响测试**：
  - `prompts.test.ts` (需更新针对系统提示词中 OS 特征替换的正则或字符串相等断言)
