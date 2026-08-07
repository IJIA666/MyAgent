# subagent-agent-mcp Specification

## Purpose

定义子代理定义级 `mcpServers` 字段的行为契约：字符串引用（共享父连接，borrowed 身份）与内联定义（per-task 作用域内动态建连，owned 身份）两种声明形态、作用域生命周期（随子代理结束关闭内联、引用不关闭、取消不销毁借用连接）、专属工具枚举/执行路由与父会话隔离，以及命名冲突 fail-closed。fresh 子代理默认可见父会话 MCP 工具为 2a 既有契约（`ToolCatalog` 为 MCP 工具签发 `freshForeground: true`，与官方一致），本能力在此基础上附加声明工具。内联连接 MUST 只登记在子代理作用域私有 map（绝不写入全局连接表），父会话工具面与枚举不受任何污染。

## Requirements

### Requirement: 定义级 mcpServers 支持引用与内联声明

系统 MUST 解析子代理定义 frontmatter 的 `mcpServers` 字段。声明形态 MUST 支持：字符串（引用全局 `McpConfig` 清单中已配置的服务器名）与对象（内联定义 `{ name: { command, args?, env? } }`，每项限一个服务器），并 MUST 支持两者混合。非法声明（非字符串且非对象、对象内不是服务器配置）MUST 拒绝该项并记录可诊断日志，MUST NOT 导致定义整体失效。

#### Scenario: 字符串引用声明

- **WHEN** 定义 frontmatter 声明 `mcpServers: [slack]` 且全局 `McpConfig` 清单中存在 `slack`
- **THEN** 该子代理使用全局 `slack` 服务器的连接与工具（borrowed 身份）
- **AND** 不创建新连接

#### Scenario: 内联定义声明

- **WHEN** 定义 frontmatter 声明 `mcpServers: [{ review-db: { command: npx, args: [review-db-mcp] } }]`
- **THEN** 系统按该配置在该子代理的 MCP 作用域内动态建立独立连接（owned 身份）
- **AND** 该连接与全局同名服务器互不干扰

#### Scenario: 非法声明被拒绝

- **WHEN** `mcpServers` 中包含非字符串、非对象或结构非法的项
- **THEN** 该项被拒绝并记录可诊断日志
- **AND** 定义其余字段与合法 MCP 声明继续生效

### Requirement: MCP 作用域按子代理任务实例隔离

系统 MUST 为每次子代理执行创建独立的 MCP 作用域句柄（对齐官方 per-call 保存连接句柄语义）。内联连接 MUST 保存在该作用域内（非全局按名索引），并发执行的两个子代理声明同名内联服务器时 MUST 各自持有独立连接，任一作用域关闭 MUST NOT 影响另一个。作用域关闭 MUST 幂等。内联连接 MUST NOT 写入全局连接表：父会话工具枚举 MUST 不包含内联服务器工具，作用域关闭后全局表 MUST 无残留。引用型服务器 MUST 复用父会话连接（不重复建连），作用域结束 MUST NOT 关闭引用型连接。

#### Scenario: 并发同名内联服务器互不干扰

- **WHEN** 两个子代理并发执行且都内联声明 `review-db`
- **THEN** 各自持有独立连接实例
- **AND** 其中一个结束后另一个的连接与工具保持可用

#### Scenario: 内联连接不进全局表

- **WHEN** 子代理的内联服务器处于连接状态
- **THEN** 父会话的 MCP 工具枚举不包含该内联服务器的工具
- **AND** 作用域关闭后全局连接表无残留连接

#### Scenario: 内联连接随子代理结束关闭

- **WHEN** 子代理正常完成、失败或取消
- **THEN** 系统在清理阶段（finally 语义）关闭该子代理作用域内全部内联 MCP 连接并回收子进程
- **AND** 父会话连接与其他子代理连接不受影响

#### Scenario: 作用域关闭幂等

- **WHEN** 作用域关闭被重复调用或与子代理终态清理并发
- **THEN** 不产生重复断开、重复清理或未处理异常

#### Scenario: 引用型连接不被子代理关闭

- **WHEN** 子代理声明引用型服务器且子代理结束
- **THEN** 该连接保持可用（父会话继续共享）
- **AND** 不执行任何断开操作

#### Scenario: 引用不存在时跳过

- **WHEN** 子代理引用全局清单中不存在的服务器名
- **THEN** 系统跳过该引用并记录 warning
- **AND** 子代理继续运行，其余 MCP 声明与工具不受影响

#### Scenario: 内联建连失败不阻断

- **WHEN** 内联服务器建连失败（命令不存在、握手失败等）
- **THEN** 系统记录 warning，对应工具不可用
- **AND** 子代理继续运行

### Requirement: 专属 MCP 工具经作用域枚举与执行且不污染父会话

系统 MUST 使 fresh 子代理默认可见父会话 MCP 工具（2a 既有契约：`ToolCatalog` 为 MCP 工具签发 `freshForeground: true`，与官方一致）。声明 `mcpServers` 的子代理 MUST 在父 MCP 工具基础上附加其声明服务器工具：内联型工具经作用域枚举附加 schema；引用型工具 schema 复用父工具面（不重复附加），但 MUST 登记 borrowed 路由身份（descriptor 与路由），使调用经作用域路由执行、取消不销毁父连接。内联服务器的工具 MUST 经该子代理的 MCP 作用域完成枚举、descriptor 与执行路由，MUST NOT 进入全局工具路由（父会话与其他子代理的工具面 MUST 不包含内联服务器工具）。动态工具执行 MUST 仍经过统一权限网关授权。工具名冲突 MUST fail-closed：合并工具面时以实际可见父工具名做完整冲突检查，冲突工具不可用并记录可诊断错误，不静默覆盖。

#### Scenario: 父 MCP 工具对 fresh 子代理默认可见

- **WHEN** fresh 子代理未声明 `mcpServers` 且枚举工具
- **THEN** 其工具面包含父会话 MCP 工具（2a 既有契约，执行仍走权限链）

#### Scenario: 内联声明服务器的工具对子代理可见

- **WHEN** 子代理声明内联型服务器且工具枚举成功
- **THEN** 该服务器的工具出现在子代理工具面中（附加在父 MCP 工具之后）
- **AND** 子代理可正常调用这些工具（经统一权限网关与作用域路由）

#### Scenario: 引用型工具登记路由身份但不重复附加

- **WHEN** 子代理声明引用型服务器且父工具面已含该服务器工具
- **THEN** 子代理工具面不出现重复的工具 schema
- **AND** 该工具经作用域路由执行（borrowed：取消只取消请求、不销毁父连接）

#### Scenario: 父会话不受内联服务器污染

- **WHEN** 子代理的内联服务器处于连接状态
- **THEN** 父会话与并发其他子代理的工具枚举、descriptor 查询与调用不包含该内联服务器的工具
- **AND** 子代理结束后作用域关闭，无残留

#### Scenario: 工具名冲突 fail-closed

- **WHEN** 子代理专属 MCP 工具与可见父工具（内置、既有 MCP 或本地工具）重名
- **THEN** 该工具不可用并记录可诊断错误
- **AND** 不静默覆盖既有工具、不附加重复 schema

### Requirement: 借用连接在取消时只取消请求、不销毁物理连接

系统 MUST 在取消携带 borrowed 身份的引用型 MCP 调用时，只中止在途请求，MUST NOT 断开或清理该服务器连接（父会话继续使用）。携带 owned 身份的内联连接取消时 MUST 允许强制断开并回收子进程（沿用既有 abort 清理语义）。取消引用型调用后，父会话 MUST 仍可正常调用该服务器工具。

#### Scenario: 取消引用型调用不销毁父连接

- **WHEN** 子代理的引用型 MCP 调用被取消（AbortSignal 触发）
- **THEN** 在途请求被中止，该服务器连接保持连接状态
- **AND** 父会话随后调用该服务器工具成功

#### Scenario: 取消内联调用强制清理

- **WHEN** 子代理的内联 MCP 调用被取消
- **THEN** 在途请求被中止且该内联连接被断开并回收子进程（owned 清理语义）
- **AND** 作用域关闭后无残留
