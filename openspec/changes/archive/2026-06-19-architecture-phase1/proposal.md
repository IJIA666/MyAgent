## 改造原因

随着项目的快速迭代，目前的底层架构出现了几处显式的臃肿与强耦合问题，极大损害了系统的可测试性、职责单一性与环境隔离度：
1. **状态容器职责过载**：`SessionContext`（会话状态容器）同时承担了物理磁盘读写（IO）和全局命令安全白名单的管理；而专门的 `ContextRepository` 退化成了纯套娃空壳。这种设计严重违背了单一职责原则，使得状态容器过于沉重且混杂了非会话级别的全局安全逻辑。
2. **配置加载强耦合与副作用污染**：核心配置加载器 `loadConfig` 体量庞大，在加载配置的同时隐式去修改磁盘文件（`ensureConfigFiles` 物理拷贝）并读取全局 `process.env`。这导致单元测试在仅想校验“路径重定向”这一个孤立零件时，必须为整个大系统“通电”（伪造大模型 API 密钥等无关环境变量），且在运行测试时会在本地产生物理文件写入和全局变量污染。

因此，现在必须对 Brain 层状态机制和配置加载系统进行一次解耦重构，以消除测试副作用，提升系统稳定性和可维护性。

## 变更内容

1. **状态容器纯内存化**：移除 `SessionContext` 内部的所有物理 IO 操作及安全白名单管理逻辑，使其彻底退化为高内聚、无副作用的纯内存数据容器。
2. **IO 逻辑下沉与安全服务剥离**：将物理落盘与加载逻辑下沉至 `ContextRepository`；将命令白名单的读取、写入及内存缓存职责剥离至新建的全局单例 `SecurityService`。
3. **配置加载器改造**：从 `loadConfig` 中移出带有物理文件拷贝副作用的 `ensureConfigFiles` 调用；将 `loadConfig` 改造为支持 `env` 环境变量对象依赖注入的无副作用管道式配置解析器，彻底隔离全局变量与磁盘副作用。

## 业务能力

### 新增业务能力
- `brain-state-isolation`: 内存状态容器与磁盘持久化 IO 的彻底解耦与物理隔离。
- `config-dependency-injection`: 配置加载器的副作用分离与环境变量依赖注入改造。

### 修改业务能力
<!-- 本次改造不涉及既有已定义的业务逻辑行为变更，故无修改业务能力 -->

## 影响范围

* **受影响代码**：
  * `src/brain/context.ts`：类结构精简，去除 IO 与白名单管理。
  * `src/brain/services/ContextRepository.ts`：承接状态落盘与读取 IO，重写 `saveState` 与 `loadState`。
  * `src/brain/plugins/HumanApprovalPlugin.ts`：重构安全白名单读取方式，由依赖 context 调整为依赖新 `SecurityService`。
  * `src/config/loader.ts`：移出文件初始化，增加 `env` 参数的依赖注入解析。
  * `src/index.ts`：在启动主流程处增加物理文件初始化调用。
* **受影响 API**：
  * `loadConfig()` 接口签名发生变更，支持可选的 `env` 键值对参数注入。
* **依赖关系**：
  * 对 `fs`、`path` 的文件系统依赖由 `src/brain/context.ts` 转移收拢至 `src/brain/services/ContextRepository.ts` 和 `src/brain/services/SecurityService.ts`。
