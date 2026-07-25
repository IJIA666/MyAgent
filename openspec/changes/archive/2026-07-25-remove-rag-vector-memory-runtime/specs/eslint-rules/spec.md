## MODIFIED Requirements

### Requirement: 强制工作区依赖注入

系统核心业务层组件（如 `SessionManager`）、存储仓储类（如 `ContextRepository`）以及各运行时中间件插件，在初始化及生命周期运行期间，必须（MUST）从注入的 `AppConfig` 实体中获取工作区根路径（`workspace` 绝对路径），而不得（MUST NOT）直接访问全局 `process.env.AUTHORIZED_WORKSPACE_DIR` 环境变量，以确保依赖链对环境的彻底解耦和多租户沙箱隔离安全。

#### Scenario: 生产启动时注入与消费

- **WHEN** 宿主环境启动装配，调用配置加载器冻结 `AppConfig` 并将其传入 `SessionManager` 构造函数
- **THEN** 会话管理器及所有现存内置插件均通过 `appConfig.workspace` 绝对路径完成日志、规则和技能文件的定位，源码中不得重新引入对 `process.env.AUTHORIZED_WORKSPACE_DIR` 的直接访问

#### Scenario: 测试执行期的沙箱重定向继承

- **WHEN** 测试用例调用 mock 工厂创建 `AppConfig` 且不提供显式的工作区覆盖
- **THEN** 工厂函数默认以 `test/setup.ts` 动态创建的临时沙箱目录作为 `workspace` 路径进行装配，从而继承物理隔离写盘

### Requirement: 测试强类型与契约机制

单元测试中对于所有现存 Driven 驱动端口（包括 `LlmPort` 和 `ToolRegistryPort`）的 Mock 桩对象，必须（MUST）实施类型安全的显式转型约束（如 `as unknown as Port`）。测试套件必须（MUST）遵循 ESLint 的 any 限制检查，除无法规避的私有方法 SpyOn 转型外，禁止使用 any 类型声明或行内豁免。

#### Scenario: 外部接口变更触发编译期报错

- **WHEN** `ToolRegistryPort` 接口新增成员方法或修改方法的出入参签名
- **THEN** 测试文件中相关的 Mock 对象必须因为类型不匹配在 TypeScript 编译检查阶段触发错误，直到测试夹具同步更新
