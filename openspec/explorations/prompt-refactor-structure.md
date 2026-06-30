# 探索主题: 提示词常量化重构与可维护性提升

## 1. 问题定义
在当前的系统提示词管理文件 [prompts.ts](file:///d:/Projects/MyAgent/src/core/usecases/brain/prompts.ts) 中，核心指令集 `BASE_SYSTEM_PROMPT` 作为一个整体模板字符串硬编码在代码中。这带来了明显的维护债：
1. **序号强耦合**：1-9 条规则手工编号，在增删或移动规则顺序时，开发者必须肉眼核对并人工重写所有后续序号，易错性高。
2. **物理缺乏隔离性**：终端安全、最小重构、语言、以及异常归因三分支规约等极长且职责异构的规则，被紧压在一个文本块中。修改时非常容易造成“手滑污染相邻红线”的低级逻辑错误。

我们需要探索一种**零运行时影响、上游前缀缓存（Prefix Cache）100% 绝对安全**的代码级重构方案，实现规约块的逻辑寻址与自动装配。

## 2. 关键发现与调研结果
- **代码库现状**：
  在 [prompts.ts](file:///d:/Projects/MyAgent/src/core/usecases/brain/prompts.ts#L10-L30) 中，9 条红线规约混排：
  - 核心文件沙箱、语言限制、长期记忆事实等较为简单；
  - 规则 5（OS 命令约束）通过 `{{OS_SECURITY_INSTRUCTIONS}}` 占位符进行冷启动加载时替换；
  - 规则 6（最小重构与 JSDoc 零注释污染）逻辑长；
  - 规则 9（异常归因三分支）最长最脆弱，频繁改动。
- **核实与洞察**：
  大模型端（特别是 OpenAI 协议下）的前缀缓存（Prefix Cache）只匹配 API 调用时投喂的最终 `system_prompt` 字节流。
  只要编译拼接发生在 Node.js 模块冷启动加载时（Compile Once），且在整个会话中固化不再发生字节改变，那么在 JS/TS 代码层对字符串的任何拼接重构对模型侧而言都是完全透明且 **100% 缓存友好（Cache-safe）** 的。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 A：维持现状（单块长文本） | 方案 B：运行时动态拼接 | 方案 C (推荐)：冷启动模块常量抽取 + 数组 map 自动装配 |
| :--- | :--- | :--- | :--- |
| **序号自愈度** | 差 ✗ (全手动修改) | 强 ✓ (动态序号拼接) | **强 ✓ (启动加载时自动 map 重新生成序号)** |
| **逻辑寻址与测试** | 差 ✗ (难定位局部规则) | 强 ✓ (变量独立可导出) | **强 ✓ (各常量独立可导出，方便编写断言单测)** |
| **Prefix Cache 命中**| **100% 稳定 ✓** | 差 ✗ (易在运行时引入动态随机变量导致缓存失效) | **100% 稳定 ✓ (仅加载时执行一次编译，会话只读)** |
| **维护安全防污染** | 差 ✗ (易手滑污染相邻行) | 强 ✓ (物理隔离) | **强 ✓ (各规则常量完全独立，物理隔离修改)** |

**推荐路径**：
采纳 **方案 C**，在不影响运行时前缀缓存命中和字节一致性的前提下，对提示词组织结构进行重构：
1. **常量抽取**：将 9 条核心规则分别提取为独立的 TypeScript 常量。例如：
   ```typescript
   export const RULE_FILE_SANDBOX = `所有文件操作都必须严格限制在授权的工作区目录下...`;
   export const RULE_TERMINAL_SAFETY = `【终端命令安全性约束】\n{{OS_SECURITY_INSTRUCTIONS}}`;
   export const RULE_ERROR_ATTRIBUTION = `【异常归因与防参数幻觉重试规则】...`;
   ```
2. **自动装配**：在模块加载阶段一次性通过数组 `map` 赋予序号并拼接成最终的 `BASE_SYSTEM_PROMPT`：
   ```typescript
   const SYSTEM_RULES = [
     RULE_FILE_SANDBOX,
     RULE_ERROR_HANDLING,
     RULE_COMMUNICATION,
     RULE_LANGUAGE,
     RULE_TERMINAL_SAFETY,
     RULE_MINIMAL_REFACTOR,
     RULE_TOOL_PRIORITY,
     RULE_LONG_TERM_MEMORY,
     RULE_ERROR_ATTRIBUTION,
   ];

   const BASE_SYSTEM_PROMPT = `你是一个专业且精确的本地智能体助手。
你严格在授权的工作区根目录下运行。
你可以使用提供给你的本地工具读取文件、写入文件以及列出目录内容。

**极其重要的核心工程红线指令 (MUST OBEY)：**
` + SYSTEM_RULES.map((rule, i) => `${i + 1}. ${rule}`).join('\n');
   ```

## 4. 约束、风险与未知项
- **冷启动开销**：JS 常量抽取与 map 拼接增加了极其微弱的冷启动 CPU 开销，但对于 CLI 智能体而言可完全忽略不计（微秒级）。
- **拼装格式测试**：重构后需要编写单元测试。一方面要断言最终渲染后的 `RESOLVED_BASE_PROMPT` **不再包含** 占位符 `{{OS_SECURITY_INSTRUCTIONS}}`（确保被成功替换消费）；另一方面要校验所有抽取的规则常量是否全部被完整装配进 `BASE_SYSTEM_PROMPT`，防范规则数组漏填。

## 5. 否决方案
- **运行时动态拼接（方案 B）**：在每次 `buildSystemPrompt` 被调用时才拼接规则。这容易在交互 turn 过程中因误引入会话级变量（如 timestamp 或是 session 状态）导致 stable 层缓存大面积破产，故予以否决。
