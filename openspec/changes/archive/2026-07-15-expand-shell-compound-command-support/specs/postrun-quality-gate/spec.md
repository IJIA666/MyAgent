## REMOVED Requirements

### Requirement: 质量门禁只能由真实或不确定代码写入触发

**Reason**: 系统不再在响应完成后隐式运行 ESLint、TypeScript 或其他代码质量检查。

**Migration**: AI 或用户需要验证修改时，继续通过终端工具显式运行对应检查命令。

### Requirement: 质量门禁必须有界反馈并避免无变更重跑

**Reason**: 自动质量门禁及其模型自动修复轮整体删除，不再存在重跑控制流。

**Migration**: 检查失败后的修复由正常对话与显式工具调用驱动，不注入伪用户消息。

### Requirement: 质量门禁必须支持取消与步骤计时

**Reason**: `QualityCheckPort` 与物理检查适配器删除，专用取消和步骤计时契约不再适用。

**Migration**: 显式终端检查继续使用终端工具已有的取消、超时和进程生命周期能力。

