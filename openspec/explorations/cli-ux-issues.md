# 探索主题: CLI 单选菜单取消渲染误导

## 1. 问题定义

当前 CLI 中所有基于 `@clack/prompts` 的单选菜单，在用户按 `ESC` 取消时，都会把当前高亮项渲染成删除线。该渲染会给出“该项被否决”或“该项已执行后取消”的视觉暗示，但用户实际上只是放弃本次选择，属于展示层误导。

## 2. 关键发现与调研结果

- **代码库现状**
  - 主菜单使用 `p.select()`，位于 [command.ts](/D:/projects/MyAgent/src/adapters/input/interface/command.ts:81)。
  - 技能子菜单使用 `p.select()`，位于 [command.ts](/D:/projects/MyAgent/src/adapters/input/interface/command.ts:110)。
  - WorkMode 交互式切换使用 `p.select()`，位于 [workmode.ts](/D:/projects/MyAgent/src/adapters/input/interface/commands/workmode.ts:22)。
  - 模型选择与 reasoning 选择都使用 `p.select()`，位于 [model.ts](/D:/projects/MyAgent/src/adapters/input/interface/commands/model.ts:20) 和 [model.ts](/D:/projects/MyAgent/src/adapters/input/interface/commands/model.ts:33)。
  - 这说明问题不是单一菜单缺陷，而是仓库内所有单选菜单共享的展示层问题。

- **库行为核实**
  - 当前仓库安装的是 `@clack/prompts` 1.6.0，而不是旧版本假设中的 1.5.x，见 [package.json](/D:/projects/MyAgent/node_modules/@clack/prompts/package.json:2)。
  - Clack 的 `select` 在 `cancelled` 状态下确实直接应用 `strikethrough` 样式，见 [index.mjs](/D:/projects/MyAgent/node_modules/@clack/prompts/dist/index.mjs:1091)。
  - `SelectOptions` 公开参数只有 `message`、`options`、`initialValue`、`maxItems`，没有关闭取消删除线的配置项，见 [index.d.mts](/D:/projects/MyAgent/node_modules/@clack/prompts/dist/index.d.mts:95)。

- **结论**
  - “删除线来自 Clack 的内建取消渲染”是已核实事实。
  - “通过公开 API 关闭该样式”在当前仓库依赖版本下不可行，也是已核实事实。
  - “用 ANSI 覆盖就一定能安全修复”不是事实，目前仓库内没有足够证据支撑。

## 3. 方案对比与推荐方向

| 评估维度 | 方案 A：保留 Clack `select` + ANSI 后处理 | 方案 B：自定义仓库内单选菜单适配层 | 方案 C：接受当前库行为 |
| :--- | :--- | :--- | :--- |
| 证据确定性 | 低，当前没有实测证明能稳定清理所有终端帧 | 高，行为由本仓代码控制 | 高，不需要新证据 |
| 边界收敛性 | 低，容易变成针对终端帧序列的脆弱补丁 | 高，可统一替换全部 `p.select()` 调用点 | 中，只能记录限制，不能消除误导 |
| 后续维护成本 | 中，依赖 Clack 内部帧结构 | 中，需要维护一个很小的单选菜单适配器 | 低 |
| 用户体验 | 不确定 | 好，可明确将取消展示为“未选择任何项” | 差，误导继续存在 |
| 推荐结论 | 不推荐直接立项 | 推荐 | 不推荐 |

**推荐路径**：方案 B。创建仓库内受控的单选菜单适配层，统一替换当前所有 `p.select()` 调用点，只修改取消渲染语义，不改业务分支、参数处理和后续 `text/confirm` 交互。

## 4. 约束、风险与未知项

- 不应顺手改动 `p.text()`、`p.confirm()` 等其它 Clack 组件；本次边界只针对单选菜单。
- 若适配层基于 `@clack/core` 或仓库内自绘菜单实现，需要补单元测试，确保取消时不再输出删除线语义。
- ANSI 后处理方案在不同终端上的实际帧序列仍未验证，因此不应把“不可行”写成确定性结论，只能写成“证据不足，不作为当前推荐路线”。

## 5. 否决方案

- **继续只修 `WorkMode` 菜单**：边界错误。相同问题同样存在于主菜单、技能选择、模型选择和 reasoning 选择。
- **只做 ANSI 清屏补丁**：当前缺少足够实测证据，而且对 Clack 内部渲染序列耦合过深。
- **接受当前库行为**：虽然成本最低，但会保留明显的取消误导，不符合当前问题定义。
