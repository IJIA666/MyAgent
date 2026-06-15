# 探索主题: 大模型代码局部更新工具 (FileEditTool) 的方案选型

## 1. 问题定义
当前 Agent 项目中的 `writeFile` 工具采用了全量覆盖写入模式（依赖 `fs.writeFileSync`）。这导致大模型在修改哪怕一行代码时也必须重新输出整个文件，不仅浪费 Token、执行耗时极长，而且经常因为达到大模型的最大输出长度限制而导致代码截断、文件损坏。因此，急需引入支持增量修改、局部替换的 FileEditTool。

## 2. 关键发现与调研结果
- **代码库现状**：当前 `src/action/native-tools/file-system.ts` 中的 `writeFileTool` 仅支持传入 `targetPath` 和全量 `content`。虽然内部有完备的 `secureResolvePath` 防御路径穿越，但修改机制过于粗暴。
- **核实与洞察**：
  - 经过针对 Anthropic Computer Use 的联网核实与 Claude 源码深度调研，发现 Claude 的真实文件修改架构是**双工具配合模式**：
    1. **FileWriteTool**：采用全量文本覆盖写入（功能与我们现在的 `writeFile` 完全一样），主要用于创建新文件或极其大面积的重写。
    2. **FileEditTool**：专门用于增量局部更新。它采用了极简的 **纯文本匹配替换** 方案，仅传入 `old_string`, `new_string`, 以及 `replace_all`，彻底抛弃了行号。
  - Claude 的系统 Prompt 中明确告诫大模型：“对于已有文件的修改，请优先使用 Edit 工具，仅在创建新文件或全量重写时使用 Write 工具”。
  - 同时，不管是写还是改，Claude 都强制要求大模型操作前必须调用读文件工具，否则主动报错拦截。通过严格的流程和唯一的字符串校验来彻底消除代码错乱的风险。
  - **补充：Opencode 的源码佐证**
    - 紧接着查阅了 `opencode` 项目（`packages/core/src/tool/`），发现英雄所见略同：Opencode 完全复刻了 Claude 的这套契约！
    - Opencode 的 `edit` 工具入参严格等于 `oldString`, `newString`, `replaceAll`，内部同样有多次匹配拦截校验。
    - Opencode 的 `write` 工具入参严格等于 `path`, `content`。
    - 此外，Opencode 提供了一个进阶版的 `apply_patch` 工具（走标准 Unified Diff），供大批量、多文件重构时使用。
  - **补充：Hermes Agent 的源码佐证**
    - 继续查阅 `hermes-agent` 项目（`tools/file_tools.py`），发现它也采用了完全一致的“三段式”架构：
    - `write_file`：全量覆盖或创建新文件，并严厉警告大模型“使用 patch 来做定向修改”。
    - `patch (mode='replace')`：必须传入 `old_string` 和 `new_string`。甚至它内部做到了 9 种策略的模糊匹配（容错缩进等），并在失败达到 3 次时，主动在 `_hint` 中引导大模型“停止尝试相似的旧字符串，去重新读文件吧”。
    - `patch (mode='patch')`：支持 V4A 格式的多文件补丁。
    - **业界共识**：至此，三大主流项目（Claude Code, Opencode, Hermes）彻底证明了：**对于单文件局部小修小补，业界目前的最优解就是抛弃行号的纯文本匹配**。

## 3. 方案对比与推荐方向
| 评估维度 | 行号边界方案 (StartLine + EndLine) | Claude 官方方案 (纯 old_string 匹配) | 结论 |
| :--- | :--- | :--- | :--- |
| 模型认知负担 | 高 (需要精准计算和记忆绝对行号) | **低 ✓** (只需复述旧代码段) | Claude 占优 |
| 容错与稳定性 | **弱 ✗** (行号极易漂移，一算错就毁坏文件) | **强 ✓** (文本特征不变即可准确匹配，不准就拦截让模型重试) | Claude 占优 |
| 实现复杂度 | 较高 (需处理文本与行号的双重校验) | **低 ✓** (字符串 replace 即可) | Claude 占优 |

**推荐路径**：全面倒向 Claude 的纯文本匹配方案。后续新设计的 `editFile` 工具仅需提供 `targetPath`, `old_string`, `new_string`, `replace_all`。摒弃所有对大模型记忆极其不友好的绝对行号约束。

## 4. 约束、风险与未知项
- **模糊缩进匹配**：大模型生成的 `old_string` 有时会在前置空格、缩进或换行符上与原文件存在细微差异。后续开发中我们需要实现一套容错匹配算法（类似 Claude 的 `findActualString`），否则大模型容易频繁遇到“未找到需替换的字符串”报错。
- **唯一性拦截**：必须在实现时严格防御 `replace_all = false` 但命中多次的情况，工具需要主动 `throw Error` 让大模型扩大 `old_string` 的前后文范围。

## 5. 否决方案
- **基于纯行号的块替换**：被舍弃，大模型的行号记忆漂移问题极难解决，算错行号导致代码插乱是典型的痛点。
- **Unified Diff / Patch 机制**：被舍弃，要求大模型输出严丝合缝的 Git Patch 格式过于严苛，极易因格式错误而应用失败。
