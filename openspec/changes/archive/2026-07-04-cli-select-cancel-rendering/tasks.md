## 1. 单选菜单适配层

- [x] 1.1 在 `src/adapters/input/interface/` 下新增仓库内单选菜单适配层，支持 `message`、`options`、`initialValue` 和取消返回。
- [x] 1.2 自定义取消态最终渲染，确保取消时不再展示删除线选项。

## 2. 调用点切换

- [x] 2.1 将 `src/adapters/input/interface/command.ts` 中主菜单与技能子菜单切换到新适配层。
- [x] 2.2 将 `src/adapters/input/interface/commands/workmode.ts` 中单选菜单切换到新适配层。
- [x] 2.3 将 `src/adapters/input/interface/commands/model.ts` 中模型选择与 reasoning 选择切换到新适配层。

## 3. 测试校验

- [x] 3.1 为适配层添加单元测试，验证取消态不包含删除线语义。
- [x] 3.2 运行针对性单测，验证关键调用点在取消路径下仍保持原有业务分支。
- [x] 3.3 运行 `npx tsc --noEmit`，确认未引入类型回归。
