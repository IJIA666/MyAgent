# grep-search

## Purpose
提供基于正则表达式与纯文本的全文检索工具，优化大模型的搜索和定位效率，避免拉取整目录文件。

## Requirements

### Requirement: 结构化全文正则与文本检索
系统虚拟 MCP Server 必须（MUST）对外暴露名为 `grepSearch` 的工具，接收 `query` (检索词), `searchPath` (检索根目录, 选填, 默认为工作区根目录), `isRegex` (是否使用正则表达式, 选填, 默认 false), `includes` (通配符匹配文件名过滤, 选填), 和 `countOnly` (只统计匹配行数, 选填, 默认 false) 参数。
搜索时必须（MUST）忽略 `.git` 目录及二进制文件。匹配行必须（MUST）按照单行最大宽度限制（如 500 字符）进行截断以防止垃圾文本刷屏。
如果 `countOnly` 为真，则必须仅返回匹配到的总行数。如果 `countOnly` 为假，则必须返回包含匹配行号、行内容以及对应文件名的结构化 JSON 数据。

#### Scenario: 成功在工作区搜索文本
- **WHEN** 虚拟 MCP 接收到针对 `grepSearch` 的调用，参数为 `query: "class SessionManager"`, `isRegex: false`
- **THEN** 工具必须扫描工作区中匹配的文件，并返回包含文件相对路径、行号以及匹配行代码的 JSON 字符串

#### Scenario: 匹配行数统计模式
- **WHEN** 虚拟 MCP 接收到针对 `grepSearch` 的调用，参数为 `query: "console.log"`, `countOnly: true`
- **THEN** 工具必须返回匹配的总行数（例如 `"匹配到的行数: 12 行"`），而非输出具体行内容
