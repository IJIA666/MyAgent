## 1. 核心工具逻辑实现

- [x] 1.1 在 `src/action/native-tools/file-system.ts` 中实现 `editFileTool` 核心逻辑，参数定义为 `targetPath`, `old_string`, `new_string`, `replace_all`。
- [x] 1.2 在 `editFileTool` 内部增加多处匹配的安全拦截逻辑（当找到多处且 `replace_all` 为 false 时，主动 throw Error 拦截）。
- [x] 1.3 在 `editFileTool` 内部增加匹配失败的安全引导提示（当未找到匹配段时，给出友好错误提示）。
- [x] 1.4 在 `src/action/native-tools/file-system.ts` 中清理 `writeFileTool`，确保其仅仅是一个纯粹的绝对全量写入工具，不带任何行号计算。

<!-- checkpoint: npx tsc --noEmit -->

## 2. 工具注册与系统契约更新

- [x] 2.1 在 `src/action/tools.ts` 中引入并注册新增的 `editFileTool`。
- [x] 2.2 在 `src/action/tools.ts` 或对应 Schema 文件中，更新 `writeFileTool` 的工具描述（Description），强制引导大模型“仅在创建新文件或必须全量覆盖时使用”。
- [x] 2.3 编写 `editFileTool` 的工具描述，强调其为增量修改的首选，并说明 `old_string` 保持上下文唯一性的重要性。

<!-- checkpoint: npx tsc --noEmit -->
