# action-polymorphic-slots

## Purpose
本地文件系统等内置工具的多态插槽式插件重构，消除硬编码路由，提高系统的扩展性与单元测试隔离度。

## Requirements

### Requirement: 声明标准的 NativeTool 契约接口
系统必须定义一个标准的 `NativeTool` 契约接口，每个本地内置工具实例都必须实现该接口。
该接口必须包含以下属性与方法：
1. `name`: 工具的名称，作为路由和查找的唯一标识。
2. `description`: 工具的描述，用于大模型理解工具用途。
3. `inputSchema`: 工具的参数模式定义，采用标准 JSON Schema 格式，用于校验输入参数。
4. `execute`: 工具的具体执行方法，接收参数并返回符合 MCP 标准的执行结果。

#### Scenario: 本地内置工具实现 NativeTool 契约接口
- **WHEN** 开发者或者系统定义一个本地内置工具（如文件读取工具 `readFile`）
- **THEN** 该工具必须实现 `NativeTool` 接口，暴露其名称、描述、JSON Schema 格式的参数定义以及对应的异步 `execute` 执行逻辑。

### Requirement: 本地虚拟服务器采用多态插槽式动态注册管理
`LocalFileSystemMcpServer` 必须通过注册表（例如 Map 容器）来动态管理 `NativeTool` 实例，消除原有的 `switch-case` 硬编码路由逻辑。
在接收到工具调用请求时，应当通过工具名称直接检索对应的 `NativeTool` 实例并调用其 `execute` 方法，且必须保持原有的工具调用行为及返回值格式 100% 兼容。

#### Scenario: 本地虚拟服务器无硬编码路由并成功分派工具调用
- **WHEN** `LocalFileSystemMcpServer` 初始化时动态注册了 `readFile`、`writeFile` 等多态工具实例，且接收到针对 `readFile` 的 `CallToolRequest`
- **THEN** 该服务器必须通过其内部的工具 Map 容器直接检索到 `readFile` 工具实例，委托调用其 `execute` 方法，并成功将符合 MCP 规范的结果返回给调用者，且其内部没有任何针对工具名称的 `switch-case` 硬编码分支。
