## MODIFIED Requirements

### Requirement: 专属写记忆工具的安全路径锁定

供 Forked 子智能体调用的 `writeMemoryFile` 工具，必须在底层强制限定写入文件的目标路径为 `.agent/MEMORY.md`，不接受 any 外部路径参数传入，严禁越权修改工作区其它文件。同时系统必须在写入物理文件后，自动对追加的内容发起异步切片并将其存入向量数据库，以保持向量索引与物理文件同步。

#### Scenario: 提炼子智能体调用工具安全落盘并同步向量数据库

- **WHEN** 提炼子智能体在 ReAct 循环中发出 `writeMemoryFile` 调用
- **THEN** 工具读取传入的内容，强制且唯一地追加写入至 `.agent/MEMORY.md` 文件中，并且系统自动在后台异步对该新增的记忆内容按行/要点列表进行拆分切片，生成其 Embedding 向量并同步 upsert 追加写入向量数据库中，保持数据状态同步。

