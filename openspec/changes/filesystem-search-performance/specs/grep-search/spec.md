## MODIFIED Requirements

### Requirement: 结构化全文正则与文本检索
系统虚拟 MCP Server 必须（MUST）对外暴露名为 `grepSearch` 的工具，接收 `query` (检索词), `searchPath` (检索根目录, 选填, 默认为工作区根目录), `isRegex` (是否使用正则表达式, 选填, 默认 false), `includes` (通配符匹配文件名过滤, 选填), 和 `countOnly` (只统计匹配行数, 选填, 默认 false) 参数。

检索执行时必须（MUST）基于原生异步流式 API 遍历工作区，严禁（MUST NOT）使用同步阻塞的目录文件树加载。遍历时必须（MUST）自动读取系统及用户自定义的忽略/排除规则（如 `.git`、`node_modules`、`.venv`、构建目录及临时测试文件夹等）。一旦判定某一当前遍历节点为被排除的目录，必须（MUST）在目录层级执行前置剪枝拦截，禁止（MUST NOT）执行下探和递归；对于检索匹配到的叶子文件，读取内容时必须（MUST）通过一个内部自研的、零外部依赖的极简信号量并发控制器进行并发句柄限流（最大并发数为 20-50 个），以防操作系统文件描述符耗尽。

匹配行必须（MUST）按照单行最大宽度限制（如 500 字符）进行截断以防止垃圾文本刷屏。如果 `countOnly` 为真，则必须仅返回匹配到的总行数。如果 `countOnly` 为假，则必须返回包含匹配行号、行内容以及对应文件名的结构化 JSON 数据。

#### Scenario: 成功在工作区搜索文本
- **WHEN** 虚拟 MCP 接收到针对 `grepSearch` 的调用，参数为 `query: "class SessionManager"`, `isRegex: false`
- **THEN** 工具必须基于异步流式剪枝扫描工作区中匹配的文件，控制文件句柄在并发限制内，并返回包含文件相对路径、行号以及匹配行代码的 JSON 字符串

#### Scenario: 匹配行数统计模式
- **WHEN** 虚拟 MCP 接收到针对 `grepSearch` 的调用，参数为 `query: "console.log"`, `countOnly: true`
- **THEN** 工具必须返回匹配的总行数（例如 `"匹配到的行数: 12 行"`），而非输出具体行内容
