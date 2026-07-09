## 需求

### 需求: 资源提取器查询

`ToolAccessMetadataProvider` 必须（MUST）支持按工具名称查询对应的资源提取器函数。

#### 场景: 查询已注册工具的资源提取器

- **WHEN** 调用 `ToolAccessMetadataProvider.getResourceExtractor(toolName)` 查询已注册元数据的工具
- **THEN** 返回该工具对应的 `(args) => SafetyResource[]` 函数

#### 场景: 查询未注册元数据的工具

- **WHEN** 调用 `ToolAccessMetadataProvider.getResourceExtractor(toolName)` 查询未声明资源提取器的工具
- **THEN** 返回 `undefined`

### 需求: 工具自带元数据声明

每个实现 `NativeTool` 接口的工具应（SHALL）可选地通过 `resourceExtractor` 和 `accessMetadata` 字段声明自身的访问元数据，替代集中式 `registerExtractorsForBuiltinTools()`。

#### 场景: 文件写入工具声明其资源提取器

- **WHEN** 定义一个文件写入类工具
- **THEN** 其 `resourceExtractor` 函数接收 `(args)`，返回读取文件路径并标记为 `{ kind: 'path', access: 'write', normalizedPath }` 的 `SafetyResource` 数组

#### 场景: 文件只读工具声明其资源提取器

- **WHEN** 定义一个文件只读类工具
- **THEN** 其 `resourceExtractor` 函数接收 `(args)`，返回标记为 `{ kind: 'path', access: 'read', normalizedPath }` 的资源

#### 场景: 命令执行工具声明其资源提取器

- **WHEN** 定义一个命令执行类工具
- **THEN** 其 `resourceExtractor` 返回 `{ kind: 'command-prefix', prefix }` 类型的 `SafetyResource`

### 需求: 访问元数据端口契约

`ToolAccessMetadataPort` 必须（MUST）作为独立端口暴露，使核心层无需依赖 `ToolRegistry` 具体实现。

#### 场景: 核心层通过端口获取资源提取器

- **WHEN** `session.ts` 需要获取某工具的资源提取器
- **THEN** 通过注入的 `ToolAccessMetadataPort` 调用 `getResourceExtractor(toolName)`，而不是将 `ToolRegistryPort` 强转为 `ToolRegistry` 后访问
