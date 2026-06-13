## 1. 重构 DefaultContextAdapter 组装逻辑

- [x] 1.1 修改 `DefaultContextAdapter.assemble` 方法，停止生成独立的局部规则与临时技能 `system` 消息，并取消往 history 数组中 splice 插入这些消息的代码。
- [x] 1.2 实现 XML 内嵌拼接逻辑，在 `assemble` 中定位最后一条 `user` 消息，将其 `content` 解析并追加拼接上经过系统前后定界符包裹的局部规则及临时技能数据。
- [x] 1.3 编写边界兜底处理，当 `baseHistory` 中不包含任何 `user` 消息时，系统自动创建一个包含 XML 注入的 `user` 消息作为第一条用户消息追加至末尾。

<!-- checkpoint: npx vitest run test/brain/adapters/DefaultContextAdapter.test.ts -->

## 2. 实现终端 UI 折叠微件渲染与日志净化

- [x] 2.1 实现 `parseXmlWidgets` 解析器，能够在文本中精准捕获并分离 `<project_rules>` 与 `<transient_skill>` 标签及其包围的文本块。
- [x] 2.2 在终端渲染层（包括 REPL.tsx 界面组件）引入可交互的 `CollapsibleCard` 终端小微件。将检测到的 XML 数据包块替换渲染为带有文件小图标、支持收起和展开的精美卡片。
- [x] 2.3 检查并更新 `rollback` 等状态干预逻辑和 `tracer.logInteraction` 日志落盘细节，确保交互日志中保存净化或占位处理后的内容。
<!-- checkpoint: npm run build -->

## 3. 修复静态分析缺陷

- [x] 3.1 修复 `DefaultContextAdapter.ts:L94` 中使用 `as any` 导致的 ESLint `no-explicit-any` 报错。
