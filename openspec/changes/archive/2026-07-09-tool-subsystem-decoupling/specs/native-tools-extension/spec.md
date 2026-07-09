## 修改需求

### 需求: 工具自带访问元数据声明

内建工具应（SHALL）通过 `NativeTool` 接口上新增的 `resourceExtractor` 和 `accessMetadata` 可选字段声明自身的访问元数据，替代 `registerExtractorsForBuiltinTools()` 集中式名称分支。

#### 场景: 文件工具声明资源提取器

- **WHEN** 定义一个文件操作类内建工具
- **THEN** 其 `resourceExtractor` 字段应返回一个接收 `(args, cwd)` 的函数，解析工具参数中的目标路径并构造 `SafetyResource` 数组

#### 场景: 命令工具声明资源提取器

- **WHEN** 定义一个命令执行类内建工具
- **THEN** 其 `resourceExtractor` 字段应返回标记为 `{ kind: 'command-prefix' }` 的安全资源

#### 场景: 新工具无需修改中心注册函数

- **WHEN** 新增一个内建工具类且它实现了 `resourceExtractor` 和 `accessMetadata` 字段
- **THEN** `ToolAccessMetadataProvider` 能自动聚合其元数据，无需在 `registerExtractorsForBuiltinTools()` 中添加新的 switch-case 分支
