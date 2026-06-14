# 探索主题: MyAgent 核心模块内聚程度与依赖分析

## 1. 问题定义
在近期完成了 `command` 分发机制和 `TokenEstimator` 算法的重构后，我们需要重新评估当前系统各核心模块（`brain`, `interface`, `action`, `config`, `utils`）的内聚程度（Cohesion）和耦合情况（Coupling），以识别潜在的架构腐化点并为下一步重构提供指引。

## 2. 关键发现与调研结果
通过对 `src` 目录下全量跨模块引用关系（Cross-module Imports）的依赖梳理，发现如下现状：

- **高内聚的典范区域**：
  - **`src/interface/commands/`**：各 Slash 命令（如 `model`, `mcp`, `help` 等）已被拆分为单一职责的独立类，仅依赖必要的上下文与配置服务，实现了极致的命令分发内聚。
  - **`src/brain/services/`**：会话生命周期与上下文管理已被拆分为 `CompactionService`、`RuleManager` 等细分领域服务，且严格遵循了边界内的依赖，没有跨域滥用引用。
  - **`src/brain/TokenEstimator.ts`**：纯粹的无状态静态计算层，完全剥离了原先与 `context.ts` 的深度绑定。

- **潜在的违规反向依赖（代码坏味道）**：
  - 🚨 **`config` 依赖 `interface`**：在 `src/config/loader.ts` 的第 15 行，出现了 `import { theme } from '../interface/theme.js';`。配置层（底层设施）为了打印彩色日志而反向依赖了 CLI 渲染层（表现层），这打破了单向依赖树原则。
  - 🚨 **`action` 依赖 `brain`**：在 `src/action/virtual-mcp.ts` 中，引用了 `loadSkillContent` from `../brain/contextLoader.js`。工具执行层本应只负责纯粹的动作触发，目前却涉足了大脑层的上下文装载逻辑，导致模块边界模糊。

## 3. 方案对比与推荐方向

针对上述发现的依赖坏味道，提供如下修复路径方案对比：

| 评估维度 | 方案 A（局部重构/解耦） | 方案 B（依赖倒置/事件驱动） | 结论 |
| :--- | :--- | :--- | :--- |
| **实施成本** | 低 ✓（仅需移动几个基础函数或封装基础 Log 类） | 高 ✗（需要重构底层通信总线） | A 占优 |
| **架构收益** | 消除环形依赖，恢复清晰的 `Config -> Brain -> Interface` 树状结构 ✓ | 极度解耦，但对当前规模属于过度设计 ✗ | A 占优 |
| **具体做法** | 将 `theme` 降级为基础 utils，将 `loadSkill` 下沉或作为抽象依赖传入。 | 引入 EventEmitter 机制，层级间完全通过事件通讯。 | A 占优 |

**推荐路径**：选择 **方案 A（局部重构）**。将 UI 颜色相关方法 (`theme.ts`) 整体平移下沉至 `src/utils/logger.ts` 或类似的基础设施包中；对于 `virtual-mcp.ts` 强依赖 `brain` 的问题，建议将其从 `action` 层移出，划归到与 `brain` 更紧密的专有系统插件域，或者将加载器通过接口参数注入。

## 4. 约束、风险与未知项
- 下沉 `theme.ts` 会导致大量的 Import 路径变更，需要借助 AST 工具或正则表达式进行全量修正。
- 当前 Agent 的业务规模尚小，上述环形依赖暂未引发内存泄漏或启动报错，但在未来引入多线程（Worker）或微服务化（MCP 拆分）时，此类强耦合将成为极大的阻碍。

## 5. 否决方案
- **保持现状**：随着命令系统的扩大和技能（Skills）的增加，`action` 与 `brain` 的交叉引用会演变成网状结构的“大泥球（Big Ball of Mud）”，坚决否决保持现状的做法。
