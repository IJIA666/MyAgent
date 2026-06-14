# Capability: read-file-stub-deduplication

## Requirements

### Requirement: 拦截重复且未被修改的文件读取请求
系统必须 (MUST) 在文件读取工具 (`readFileTool`) 被调用时，对已经读取过的文件路径及读取范围进行去重校验。当发现完全一致的读取请求且磁盘文件的 `mtime` 没有发生改变时，系统必须阻止读取物理文件内容，转而返回预设的 Stub 占位符提示词。

#### Scenario: 首次读取文件
- **WHEN** 客户端请求读取文件 `/path/to/file` 的范围 `[offset, limit]`，且系统内存字典中不存在该对应记录时
- **THEN** 系统应正常执行物理读取，将该读取快照（包含文件绝对路径、`offset`、`limit` 以及当前的 `mtimeMs`）缓存到运行时内存字典中，并返回完整文件正文内容

#### Scenario: 再次读取文件且文件未被修改
- **WHEN** 客户端发起对已缓存文件记录的二次请求，且本次的 `[offset, limit]` 与缓存一致，且此时获取到的物理磁盘 `mtimeMs` 等于缓存中的 `mtimeMs`
- **THEN** 系统不应去读取真实文件内容，而是必须返回固定的 Stub 指针提示词（引导大模型向前追溯上下文中的早期 `tool_result`）

#### Scenario: 再次读取文件但文件已被修改
- **WHEN** 客户端发起对已缓存文件记录的二次请求，但本次的最新磁盘 `mtimeMs` 不等于缓存中的 `mtimeMs`
- **THEN** 系统应重新执行真实的物理读取操作，并将读取结果及其最新的 `mtimeMs` 覆盖更新到内存字典中，随后返回全新的文件正文内容
