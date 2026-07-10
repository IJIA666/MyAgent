## 1. 诊断策略与配置边界

- [x] 1.1 定义 `operational`、`audit`、`replay` 三档诊断策略及其制品映射，默认开启 operational/audit、关闭 replay。
- [x] 1.2 在现有配置加载边界增加 replay、脱敏 pattern 和 trace/audit retention 配置，缺省值为 7 天、20 个会话文件，限制最大值为 30 天、100 个会话文件。
- [x] 1.3 为非法策略、超出 retention 上限和不支持的 pattern 配置提供不泄露原始敏感值的错误处理，并补充用户配置说明。

<!-- checkpoint: npx tsc --noEmit -->

## 2. 统一写盘前数据治理器

- [x] 2.1 新增纯数据 sanitizer，递归处理对象、数组和字符串，保证返回安全副本且不修改 logger、trace、audit 的原始输入。
- [x] 2.2 实现敏感字段识别、基础 secret/token/authorization/password/headers 等字段掩码或摘要，以及内置和用户自定义文本 pattern 替换。
- [x] 2.3 实现超长字符串/数组摘要和 CR/LF/JSONL 分隔符清洗，并覆盖嵌套对象、错误对象、URL/连接串和未知字段中的秘密。
- [x] 2.4 确保基础安全字段脱敏不受日志等级、普通脱敏开关或 replay 模式影响。
- [x] 2.5 为 sanitizer 编写单元测试，验证无原文泄露、原始输入不变、嵌套结构保留、pattern 合并和异常输入容错。

<!-- checkpoint: npx vitest run test/utils/diagnostic-sanitizer.test.ts -->

## 3. 接入三类诊断写盘边界

- [x] 3.1 在统一 logger 交给 console/file sink 前治理 message、Error 属性和结构化 properties，同时保持现有级别过滤与 `run.log` 轮转行为。
- [x] 3.2 调整 `TracerLogPlugin` 的默认 audit 载荷为事件、关联、策略、资源摘要、patch 操作/路径和不可逆摘要，移除原始 toolCall、patch value、prompt 和 result 写盘。
- [x] 3.3 调整 `AgentTracer`/agent loop 的默认 trace 为 metadata-only，并在显式 replay 时保留回放字段；写盘前统一调用 sanitizer。
- [x] 3.4 保留 session snapshot 的完整恢复语义，不让诊断策略或 sanitizer 改写 `ContextRepository` 的保存/加载契约。
- [x] 3.5 补充 logger、audit plugin 和 agent loop 的契约测试，验证默认模式、replay 模式、工具载荷/patch 脱敏和 session snapshot 不受影响。

<!-- checkpoint: npx vitest run test/config/logger-file-format.test.ts test/core/usecases/plugins/plugins.test.ts test/core/usecases/engine/agent-loop.test.ts test/contract/session-persistence.test.ts -->

## 4. Trace reader 与诊断保留清理

- [x] 4.1 为 trace metadata-only/replay 记录增加 capture mode/version 标识，更新 trace format 和 reader，使历史完整 trace 继续可 hydration，metadata-only trace 可诊断但不会被误当作完整回放。
- [x] 4.2 在 trace/audit 写入器创建或首次写入前实现按天数和会话数量清理，保护当前活跃文件，清理失败只记录受治理事件且不阻断 Agent。
- [x] 4.3 保持 `run.log` 的 10MB × 5 轮转独立于 trace/audit 清理，不扩展 `LifecycleManager`，不重写同步写盘管道。
- [x] 4.4 为历史 trace 读取、metadata-only 读取、replay hydration、保留边界、活跃文件保护和清理失败补充测试。

<!-- checkpoint: npx vitest run test/core/domain/trace-reader.test.ts test/core/domain/tracer.test.ts test/contract/log-pipeline.test.ts -->

## 5. 文档、集成验证与交付复核

- [x] 5.1 更新配置和诊断文档，说明三档策略、默认安全行为、replay 敏感数据提示、retention 默认/上限及 session snapshot 的独立边界。
- [x] 5.2 增加端到端或契约验证，读取实际生成的 run.log、trace、audit 文件，断言秘密、原始工具载荷、prompt 和 patch value 不会在默认模式落盘。
- [x] 5.3 验证显式 replay 的短期回放路径、历史 trace 兼容、旧配置迁移和错误清理不阻断主流程。
- [x] 5.4 复核变更未引入 session snapshot 改写、异步日志管道重构、集中式遥测或新的生命周期框架，并完成类型检查与相关测试。

<!-- checkpoint: npx tsc --noEmit -->
