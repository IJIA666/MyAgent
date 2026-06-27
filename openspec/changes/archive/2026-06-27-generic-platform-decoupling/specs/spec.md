## 新增需求

### 需求: 系统人设自适应平台装配
系统提示词引擎必须能够自动依据当前宿主主机的物理操作系统类型，将通用静态提示词模板中的 `{{OS_SECURITY_INSTRUCTIONS}}` 占位符，自适应地在模块初始化阶段替换为对齐当前宿主操作系统的特定安全规则指示，消除平台冲突。

#### 场景: 平台处于 Windows 环境
- **WHEN** 宿主物理操作系统 `process.platform` 为 `win32` 且模块被加载导入时
- **THEN** 系统提示词只读常量 `RESOLVED_BASE_PROMPT` 中必须自适应包含 Windows 原生命令红线及复合符号阻断约束。

#### 场景: 平台处于 macOS 或 Linux 环境
- **WHEN** 宿主物理操作系统 `process.platform` 探测为 `darwin` 或 `linux` 且模块被加载导入时
- **THEN** 系统提示词只读常量 `RESOLVED_BASE_PROMPT` 中必须自适应包含 POSIX 规范与防命令注入逃逸约束，绝不能出现 Windows 字眼与特有命令限制。

### 需求: 嵌入向量拆批职责下沉
领域核心长期记忆服务在处理批量文本生成嵌入向量时，必须对物理提供商的单次请求限制（如阿里单次上限 10 条）保持零感知。

#### 场景: 提交大批量文本嵌入向量请求
- **WHEN** 领域层 MemoryService 触发 batchEmbeddings 调用
- **THEN** 必须直接将全量文本数组传达给下游驱动 `EmbeddingPort.embed(texts)`，由具体适配器实现限流分发与批合并，保证领域层绝对无偏差。
