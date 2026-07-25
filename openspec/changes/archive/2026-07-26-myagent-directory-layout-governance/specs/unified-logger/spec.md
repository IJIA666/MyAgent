## MODIFIED Requirements

### Requirement: 统一诊断日志记录与分级输出

系统必须提供全局统一的诊断日志模块，支持 `DEBUG`、`INFO`、`WARN`、`ERROR` 四个级别、控制台输出和安全文件追加。配置加载完成前 MUST 只使用控制台或有界内存 bootstrap sink；授权 workspace 与项目应用数据路径确认后，文件 sink MUST 写入当前项目 `logs/run.log`。所有消息和属性在进入任一 sink 前 MUST 完成字段感知脱敏、长度限制和换行清洗。

#### Scenario: 配置确认前的启动日志

- **WHEN** 进程已经开始启动但授权 workspace 尚未解析完成
- **THEN** logger 不创建任何 `.agent`、workspace `.myagent` 或用户项目日志文件，只通过控制台或有界内存缓冲记录必要事件

#### Scenario: 诊断日志的分级控制与落盘行为

- **WHEN** 授权 workspace 与项目应用数据路径确认，且未运行在默认静音的单元测试环境
- **THEN** 控制台默认展示 INFO 及以上日志，文件 sink 将经过安全治理的全部级别事件写入当前项目 `logs/run.log`

#### Scenario: 日志大小与数量轮转控制

- **WHEN** 当前项目 `logs/run.log` 达到或超过 10MB
- **THEN** 系统自动轮转并最多保留 `run.log.1` 至 `run.log.5`，不得影响其他项目日志

#### Scenario: 终端环境变量动态级别控制

- **WHEN** 启动时提供有效 `LOG_LEVEL`
- **THEN** 控制台最低展示级别调整为指定值，同时不改变文件日志路径和基础敏感字段脱敏

#### Scenario: 用户应用数据目录不可写

- **WHEN** 文件 sink 无法创建当前项目日志目录
- **THEN** logger 通过控制台输出受治理错误，应用不得回退到 workspace 写入 `run.log`
