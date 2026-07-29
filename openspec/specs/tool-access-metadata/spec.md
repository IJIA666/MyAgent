## Purpose

定义工具授权所需资源与访问元数据的查询和声明契约。该规范确保每个有副作用工具提供可验证的类型化资源证据，未知资源不能依靠宽泛兼容字段或工具自称获得放行。
## Requirements
### Requirement: Typed Authorization Resource Evidence

工具访问元数据 MUST 使用穷尽判别联合描述文件、目录范围、命令、网络端点、外部副作用、MCP 调用和未知资源。每种证据 MUST 包含原始表达式、规范化资源、操作、范围、来源节点、敏感度、provenance 和可信度。

#### Scenario: A file resource is produced

- **WHEN** 文件工具适配器解析目标路径
- **THEN** 证据 MUST 携带真实物理路径、read/write 操作、精确或目录范围、protected 状态和 `host-verified` 可信度

#### Scenario: An MCP server claims a resource

- **WHEN** MCP annotations 或服务响应声明某资源只读
- **THEN** 证据 MUST 标记为 `external-claimed`
- **THEN** 该证据 MUST NOT 独立产生 allow 或可复用路径授权

### Requirement: Unknown Resource Evidence Fails Conservatively

系统 MUST 使用显式 `unknown` 证据表示无法规范化或无法由宿主验证的资源，不得退回宽泛字典或空资源来表示任意访问。

#### Scenario: An effectful resource cannot be normalized

- **WHEN** 有副作用工具无法确定目标资源或访问范围
- **THEN** 最终候选 MUST 至少为 `ask`
- **THEN** headless、dontAsk 或缺少可信审批时 MUST 拒绝
