# 规格契约：端口契约纯度提升

## Purpose

定义 driving 与 driven ports 对核心实现类型的隔离边界。该规范保证输入适配器、工具运行时和插件消费者只依赖稳定契约，不因权限或会话实现迁移而被迫导入具体服务类。

## Requirements

### Requirement: Driving Port Independence

`src/ports/driving/` 下对外暴露的驱动端口契约必须（MUST）以端口层自有契约或纯数据结构表达，不得（MUST NOT）直接暴露 `src/core/` 中的具体实现类或内部类型。

#### Scenario: ChatUseCase does not expose core implementation types
- **WHEN** 外部模块导入并使用 `ChatUseCase` 这类驱动端口接口时
- **THEN** 其公开属性、方法参数与事件类型必须（MUST）来自端口层自有契约或与实现无关的纯数据结构
- **THEN** 外部模块不应（MUST NOT）因为使用驱动端口接口而被迫导入或理解 `SessionManager`、`ApprovalInteractionService`、`agent-loop.ts` 等核心实现类型

#### Scenario: Approval interaction remains available through driving port contract
- **WHEN** 输入适配器需要发起、等待或响应审批交互时
- **THEN** 驱动端口契约必须（MUST）提供足以完成该交互的抽象能力
- **THEN** 这些能力的暴露方式不得（MUST NOT）要求适配器直接持有核心审批服务类

### Requirement: Driven Port Independence

`src/ports/driven/` 下的端口接口定义必须（MUST）只依赖端口层拥有的契约类型或纯数据结构，不得（MUST NOT）直接引用 `src/core/` 中的安全、插件或领域内部类型。

#### Scenario: Tool runtime contracts do not expose adapter implementations
- **WHEN** driven port 描述工具目录、执行生命周期或授权请求边界时
- **THEN** 其输入输出类型必须（MUST）由端口层拥有，或由端口层共享类型表达
- **THEN** 端口消费者不得（MUST NOT）因为使用这些接口而依赖 core 内部安全模型文件

#### Scenario: Plugin-facing port contracts do not reference core-only hook types
- **WHEN** `AgentPlugin` 这类 driven port 暴露插件注册或 hook 契约时
- **THEN** 其对外暴露的事件键、回调签名和相关类型必须（MUST）以端口层契约表达
- **THEN** 不得（MUST NOT）直接把 core 内部插件类型文件作为端口 API 的一部分泄漏出去

### Requirement: Input Adapter Depends on Driving Port

输入适配器的核心会话依赖必须（MUST）收敛到驱动端口契约，而不是直接依赖核心实现类。

#### Scenario: CliFacade is constructed from ChatUseCase-compatible contract
- **WHEN** 构造 `CliFacade` 或等价输入适配器时
- **THEN** 其主依赖必须（MUST）是 `ChatUseCase` 或与之等价的驱动端口契约
- **THEN** 适配器完成渲染、审批、交互恢复与会话控制所需的能力，必须（MUST）通过驱动端口契约获得，而不是通过 `SessionManager` 等核心实体特有 API 获得

#### Scenario: Input adapter behavior remains unchanged after dependency narrowing
- **WHEN** 输入适配器从直接依赖核心实现类切换为依赖驱动端口契约后
- **THEN** 现有审批处理、挂起交互恢复、历史重绘、模型状态展示与中断控制行为必须（MUST）保持不变
