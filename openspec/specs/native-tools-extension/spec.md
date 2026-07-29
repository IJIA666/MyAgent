## Purpose

定义原生文件、目录、搜索、补丁和只读辅助工具的扩展契约。该规范要求每个有副作用入口使用正式授权适配器，并让批量工具在物理路径、预算、部分失败和结果完整性方面保持可验证行为。

## Requirements

### Requirement: 目录与路径的跨平台安全管理

工具 MUST 在物理层面彻底磨平 Windows 与 Linux/Unix 等不同操作系统在目录创建、路径删除、复制与移动上的命令选项差异。同时，所有敏感操作工具必须在底层强制执行工作区沙箱越权校验，阻断任何超出授权范围的路径访问。

#### Scenario: 安全删除工作区内有效路径
- **WHEN** 大模型发起 `deletePath` 工具调用，并传入了工作区内合法的目标路径 `src/utils/temp.ts` 以及通过校验的凭证。
- **THEN** 工具调用原生的文件删除 API 成功移除该路径，并返回删除成功的 JSON 信息。

#### Scenario: 超出授权工作区路径的删除被阻断
- **WHEN** 大模型试图调用 `deletePath` 删除工作区外的系统目录（ 例如传入路径 `C:/Windows` ）。
- **THEN** 工具在底层路径安全校验逻辑中检测到该路径超出了授权工作区，立刻物理阻断执行并抛出错误异常 `"拒绝越权操作：目标路径超出了授权的工作区范围"` 。

#### Scenario: 目录的跨平台递归创建
- **WHEN** 大模型发起 `createDirectory` 工具调用，传入多级未创建的目录路径 `src/components/common/buttons` 。
- **THEN** 工具在底层自动执行递归创建，成功在磁盘上生成所有缺失的父级文件夹，不再依赖各系统下的 `mkdir` 命令。

---

### Requirement: 通用目录工具必须支持受限的直接子目录比较测量

`listFiles` 必须（MUST）在显式请求时支持对目标目录的直接子目录进行聚合占用比较；默认列目录行为必须保持非递归和低噪声。比较测量必须共享有限预算并返回每个对象独立的完整性。

#### Scenario: 默认列目录不触发聚合扫描
- **WHEN** 调用方未显式请求目录测量
- **THEN** `listFiles` 只能读取直接子项，不得递归计算任何目录聚合大小

#### Scenario: 受限比较多个直接子目录
- **WHEN** 调用方显式请求直接子目录比较并提供深度、条目、字节和时间上限
- **THEN** 工具必须在共享预算内轮转扫描各直接子目录，并分别返回 observedSizeBytes、计数、耗时、错误和完整性

#### Scenario: 单个子目录无权限
- **WHEN** 某个直接子目录或其后代因权限被拒绝而无法读取
- **THEN** 工具必须记录该对象的跳过项和部分完整性，同时继续测量其他可访问子目录；目标根目录自身不可读时才允许整个调用失败

### Requirement: 递归测量必须限制链接、卷边界与取消

目录测量必须（MUST）默认不跟随符号链接、junction 或 reparse point，不跨文件系统或卷边界，并响应 AbortSignal。

#### Scenario: 遇到目录链接
- **WHEN** 测量扫描遇到符号链接、junction 或其他可重定向目录项
- **THEN** 工具必须跳过递归并在结果中增加对应跳过计数，不得形成循环或越过授权范围

#### Scenario: 达到时间预算
- **WHEN** 扫描耗时达到 maxDurationMs 或收到 AbortSignal
- **THEN** 工具必须尽快停止，保留已经获得的对象级部分结果，并标记 time-limit 或 cancelled 完整性原因

### Requirement: 部分测量不得伪装成目录总量

工具必须（MUST）明确区分完整总量与部分观测值。只有覆盖完整时才能返回 totalSizeBytes；截断、跳过或取消时必须返回 observedSizeBytes 和 lower-bound/partial 语义。

#### Scenario: maxEntries 导致截断
- **WHEN** 扫描达到 maxEntries 但仍有未访问条目
- **THEN** 结果必须标记为非完整，给出截断原因，且不得把 observedSizeBytes 声称为完整总大小

### Requirement: 高吞吐读取的前置体积熔断与拒签机制

批量读取多文件工具 MUST 采用“前置体积熔断”机制代替“尾部物理硬截断”，以防大模型接收到不完整代码导致解析幻觉。当请求的一批文件字符体积超限时，必须原生地报错熔断并返回带结构化大小清单的拒签信息。

为了确保超大文件解析时的系统性能并规避内存卡顿风险，工具在提取大纲结构时**严禁使用重型的 TS Compiler API 等编译级 AST 解析器**。必须采用轻量级正则表达式行捕获（ 提取 `class` / `function` / `interface` / `export const` 等关键字行号与签名 ），对于无法进行正则提取的类型文件，直接降级返回“文件总行数与首尾各 20 行代码”作为结构大纲，保障熔断性能。

#### Scenario: 批量读取文件总体积超限熔断
- **WHEN** 大模型发起 `readManyFiles` 工具调用并传入 5 个文件路径，这 5 个文件的字符总数达到了 80,000 字符（ 超出了 50,000 字符的安全熔断阈值 ）。
- **THEN** 工具执行前置拦截，直接抛出拒签错误 `"Size limit exceeded"` 并以 JSON 格式返回这 5 个文件的实际大小清单、行数、以及通过轻量正则捕获的接口/类定义结构大纲（ 或降级为首尾各 20 行的文本片段 ）。

---

### Requirement: 补丁修补双轨并行控制

代码修补 MUST 支持“严格模式补丁”与“上下文签名特征块替换”的双轨并行控制。必须杜绝使用可能导致偏置覆盖的自研模糊匹配算法。

#### Scenario: 严格 Patch 模式下上下文错位报错
- **WHEN** 大模型使用 `applyPatch` 工具的严格模式传入了一段带有空格偏移或行号冲突的 Unified Diff 补丁。
- **THEN** 工具经过标准补丁库解析发现无法精确对齐，立即放弃任何修改，物理阻断并返回错误提示 `"Patch apply failed: context mismatch"` 。

#### Scenario: 上下文签名特征块替换精确定位
- **WHEN** 大模型在由于先前修改产生行号漂移时，调用 `applyPatch` 的块替换模式，并传入了 `[startLine, endLine]` 大致范围、以及期望原文特征签名 `expectedContent` （ 提供 2-3 行 ）和替换的新内容。
- **THEN** 工具在指定范围内滑动窗口，成功匹配特征签名定位，完成块内容替换并写入文件，成功规避行号漂移。

---

### Requirement: 只读版 Git 辅助信息拉取

Git 工具链 MUST 被强行限制在只读范围内，绝对不允许调用任何会产生 write / commit / push 等物理变更的 Git 指令。所有 Git 只读工具必须对控制台 stdout 的 ANSI 颜色标记进行过滤，返回纯净结构化的数据。

#### Scenario: 只读拉取 Git 状态
- **WHEN** 大模型调用 `gitShowStatus` 工具检索修改列表。
- **THEN** 工具在底层调用只读 `git status` ，经过滤后将未跟踪（ untracked ）、已修改（ modified ）等相对文件路径列表以结构化 JSON 数据返回。

---

### Requirement: 高危操作的挂起式安全确权拦截

所有底层涉及目录或文件删除的破坏性操作（如 `deletePath`）MUST 接入统一 ToolCallGateway。工具适配器必须把删除声明为独立 destructive operation；最终决策为 ask 时，CLI 只能展示适配器签发的 Allow once 或 Deny，不得把普通编辑模式或目录授权扩展到删除操作。

#### Scenario: 高危删除操作触发挂起确权
- **WHEN** 大模型发起 `deletePath` 试图删除工作区内的临时文件，在工具被调用时。
- **THEN** ToolCallGateway 必须在实际删除前产生 ask 并等待 actionId；只有 Allow once 完整提交并签发单次 execution grant 后，ToolExecutor 才能执行物理删除。

---

### Requirement: 有副作用工具自带正式授权适配器

有副作用内建工具必须（MUST）通过 `NativeTool.authorizationAdapter` 声明稳定 permission identity、真实参数规范化、类型化资源证据和安全审批动作。生产运行时不得继续装配独立 `resourceExtractor`/`accessMetadata` 端口作为第二套授权资源模型。

#### Scenario: 文件工具声明正式授权适配器

- **WHEN** 定义一个文件操作类内建工具
- **THEN** 其 authorizationAdapter 必须解析真实路径参数，并构造 file 或 directory-scope ResourceEvidence

#### Scenario: 命令工具声明 Shell 授权适配器

- **WHEN** 定义一个命令执行类内建工具
- **THEN** 其 authorizationAdapter 必须按已决议 Shell family 复用结构化命令分析，并逐节点构造 command、network 和 file evidence

#### Scenario: 缺少适配器的有副作用工具 fail closed

- **WHEN** 新增一个 effectful 内建工具但没有注册 authorizationAdapter
- **THEN** ToolCatalog 必须拒绝注册，effectful entrypoint coverage 测试必须失败

---

### Requirement: 批量只读工具必须返回统一部分成功结果

所有会枚举、扫描或批量读取多个对象的内建只读工具必须（MUST）在单个对象失败时保留其他成功结果，并返回成功对象、失败对象、跳过对象、截断或取消原因、覆盖范围和完整性。只有根目标不可访问、参数契约无效或执行无法开始时才允许整体失败。

#### Scenario: 单个子项无权限但其他结果可用

- **WHEN** 批量工具处理目标集合时某个子项因权限拒绝无法读取
- **THEN** 工具必须记录该子项错误并继续处理其他对象，整体结果标记为 partial

#### Scenario: 根目标不可访问

- **WHEN** 工具连根目标都无法访问
- **THEN** 工具可以整体失败，但必须返回明确的根目标、失败阶段和错误分类

#### Scenario: 预算截断返回下界

- **WHEN** 工具达到时间、条目、字节或输出预算
- **THEN** 工具必须返回已完成结果、未完成原因和 lower-bound/partial，不得把观察值命名为完整总量

#### Scenario: 条件参数在执行前校验

- **WHEN** 调用方启用需要附加预算参数的能力但遗漏必需参数
- **THEN** 工具必须在扫描任何子项前返回参数校验错误，或使用 schema 声明的安全默认值，不得让无关文件错误遮蔽参数问题

#### Scenario: 大量失败项聚合

- **WHEN** 失败或跳过对象数量会导致返回体过大
- **THEN** 工具必须按错误类型汇总计数并保留有限样本，完整明细可卸载到工具输出文件
