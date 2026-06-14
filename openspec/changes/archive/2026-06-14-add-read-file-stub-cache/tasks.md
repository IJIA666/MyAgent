## 1. 核心工具逻辑改造 (readFileTool)

- [x] 1.1 在文件读取工具所在的作用域或模块内，初始化用于记录读取快照的内存字典 `readFileState = new Map()`。
- [x] 1.2 在 `readFileTool` 执行主体中，利用文件系统 API 获取入参目标文件的当前 `mtimeMs`（修改时间戳）。
- [x] 1.3 实现校验拦截逻辑：对比 `readFileState` 中是否存在该绝对文件路径的缓存记录，且当前的 `offset`、`limit` 以及物理获取到的 `mtimeMs` 是否与字典记录完全一致。
- [x] 1.4 若比对一致，则熔断并跳过真实的物理文件读取，直接构造并返回固定的 Stub 提示词 `"File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading."`。
- [x] 1.5 若比对不一致（涵盖首次读取、请求范围发生变化或磁盘文件被修改），则继续执行标准的物理文件读取获取正文。
- [x] 1.6 每次成功执行完物理读取后，将当前绝对路径、传入的 `offset` 和 `limit`，以及最新的 `mtimeMs` 快照覆盖或保存至 `readFileState` 中。

<!-- checkpoint: npm run build -->

## 2. 单元测试与验证

- [x] 2.1 增加 `readFileTool` 测试用例：模拟连续两次读取同一未被修改的文件，断言第二次操作必定触发缓存拦截并返回 Stub。
- [x] 2.2 增加 `readFileTool` 测试用例：模拟文件首次读取后被模拟的外部程序或编辑工具修改（mtime 发生变化），断言第二次读取必定会执行真实加载，返回最新的正文。

<!-- checkpoint: npm run test -->
