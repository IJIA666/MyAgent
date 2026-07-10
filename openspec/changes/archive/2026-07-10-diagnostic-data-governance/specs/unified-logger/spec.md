## MODIFIED Requirements

### Requirement: 统一诊断日志记录与分级输出

系统必须提供全局统一的诊断日志记录模块（ Logger ），支持 `DEBUG` 、 `INFO` 、 `WARN` 、 `ERROR` 四个日志级别，实现控制台彩色输出与日志文件安全追加落盘，并支持基于环境变量和文件的分级过滤。所有消息和结构化属性 MUST 在交给任一 sink 前经过统一的字段感知脱敏、长度限制和换行清洗；日志等级不得关闭基础安全字段脱敏。

#### Scenario: 诊断日志的分级控制与落盘行为

- **WHEN** 系统启动且未运行在单元测试环境中时
- **THEN** 诊断日志模块必须初始化。控制台输出（ ConsoleSink ）默认仅展示 `INFO` 及以上级别的彩色格式化日志；落盘文件输出（ RotatingFileSink ）必须将经过安全治理的日志事件全量（含 `DEBUG` 级）异步安全写入 `.myagent/run.log` 文件，且不得写入基础敏感字段原文

#### Scenario: 日志大小与数量轮转控制

- **WHEN** 日志文件 `.myagent/run.log` 的大小达到或超过 `10MB`（ 即 10 * 1024 * 1024 字节 ）时
- **THEN** 系统必须自动触发日志文件轮转，保留最多 5 个历史日志备份文件（ 即 `run.log.1` 至 `run.log.5` ），避免磁盘空间无限制膨胀。

#### Scenario: 终端环境变量动态级别控制

- **WHEN** 启动系统时传入了环境变量 `LOG_LEVEL` （ 如 `LOG_LEVEL=debug` ）
- **THEN** 控制台输出（ ConsoleSink ）的最低展示级别必须调整为该环境变量指定的级别，同时不改变写盘前的基础敏感字段脱敏行为。

### Requirement: Immer 变更补丁的大文本摘要压缩

系统在记录 `[Plugin Trace]` 诊断日志时，必须对 Immer 变更补丁（ Patches ）中产生的大文本内容进行 Map 摘要压缩，并且将该 trace 日志级别定为 `DEBUG` 级，以防止终端产生海量信息噪音；在摘要压缩前 MUST 执行字段感知脱敏，不能以长度压缩代替秘密清除。

#### Scenario: Immer 变更日志的文本截断压缩与降级展示

- **WHEN** 系统在 Hook 中件间管道执行完毕产生 Immer 变更补丁（ Patches ），且 patches 数组长度大于 0 时
- **THEN** 系统必须先对敏感字段和值执行脱敏，再对 patches 数组中的每一项 value 进行压缩：若 value 为字符串类型且长度超过 100 字符，则在日志中将其替换为 `"[String: X chars]"`（ X 为原字符串长度 ）；若 value 为数组类型，则替换为 `"[Array: X items]"` ；处理后的日志以 `DEBUG` 级别发出，且不得包含被脱敏前的秘密
