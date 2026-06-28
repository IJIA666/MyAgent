## 1. 命令行核心类开发与导出 (Core Command Development)

- [x] 1.1 在 `src/adapters/input/interface/commands/workmode.ts` 实现 `WorkModeCommand` 核心逻辑，支持查询及同步切换 Session 内存模式与终端工具全局配置模式。
- [x] 1.2 在 `src/adapters/input/interface/commands/index.ts` 中追加对新命令类 `WorkModeCommand` 的重导出声明。

<!-- checkpoint: npm run build -->

## 2. 命令注册与可视化图形菜单整合 (Registry & UI Menu Integration)

- [x] 2.1 在 `src/adapters/input/interface/command.ts` 的 `CommandRegistry` 构造方法中实例化注册 `this.register(new WorkModeCommand())`。
- [x] 2.2 在 `showInteractiveMenu()` 方法的可选 `options` 选项中添加 `/workmode`，并在派发判定的 `includes` 过滤列表中补上 `'workmode'` 标号。

<!-- checkpoint: npm run build -->

## 3. 帮助菜单信息同步与缺陷修补 (Help Document Synchronization)

- [x] 3.1 在 `src/adapters/input/interface/commands/help.ts` 的命令说明打印列表里增加 `/workmode` 渲染行。
- [x] 3.2 在 `help.ts` 中同步将原有的 `/model <id>` 纠正为可选的 `/model [id]` 提示，解决帮助文档的表述缺陷。

<!-- checkpoint: npm run build -->

## 4. 单元测试与全量功能验证 (Unit Testing & Validation)

- [x] 4.1 编写 `test/adapters/input/interface/commands/workmode.test.ts` 新单元测试用例，覆盖无参、有参及非法参数下的输出拦截断言。
- [x] 4.2 物理运行针对新命令的专项单元测试，确保逻辑无误。
- [x] 4.3 物理运行项目全量测试套件，确认重构未造成任何回归故障。

<!-- checkpoint: npm run test -->
