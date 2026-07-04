## 改造原因

当前 CLI 中所有使用 `@clack/prompts` 的单选菜单，在用户按 `ESC` 取消时都会把当前高亮项渲染为删除线。该渲染不是业务语义，而是第三方库的默认取消表现，会让用户误以为某个选项被显式否决或曾被选中过。

仓库内该问题不是单点，而是出现在以下全部 `p.select()` 调用点：

- `/` 主菜单
- 技能选择子菜单
- `/workmode` 交互式模式选择
- `/model` 模型选择
- `/model` reasoning 等级选择

由于 `@clack/prompts` 当前公开 `SelectOptions` 并没有关闭取消删除线的配置项，本次需要引入仓库内受控的单选菜单适配层，统一接管取消渲染语义。

## 变更内容

1. 新增仓库内单选菜单适配层，统一定义取消时的最终渲染，确保取消仅显示“操作已取消”，不再展示删除线选项。
2. 将仓库内所有 `p.select()` 单选调用点切换到该适配层。
3. 为适配层渲染逻辑与关键调用点补充单元测试，锁定取消语义。

无 BREAKING 变更。

## 业务能力

### 新增业务能力

- `cli-select-cancel-rendering`: CLI 单选菜单在取消时支持仓库级统一渲染策略，不再暴露第三方库默认的删除线取消表现。

## 影响范围

- `src/adapters/input/interface/command.ts`
- `src/adapters/input/interface/commands/model.ts`
- `src/adapters/input/interface/commands/workmode.ts`
- `src/adapters/input/interface/` 下新增单选菜单适配层
- 相关单元测试
