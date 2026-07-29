# 实施验证记录

## 验证结论

本 change 已在 2026-07-28 的原生 Windows 环境完成自动化验证和真实 CLI 验收。权限决策、审批动作、不可变执行计划、文件/MCP/Terminal 适配器、凭据隔离、Auto Memory 与管理命令均走生产组合根，而不是测试专用旁路。

## 自动化验证

| 检查 | 结果 |
| --- | --- |
| `npm test -- --maxWorkers=1` | 通过，82 个测试文件、919 个测试；已删除 1 个只验证旧 metadata provider 的文件及其 4 个旧用例 |
| `npm run test:contract -- --maxWorkers=1` | 通过，11 个测试文件、103 个测试 |
| `npm run test:integration -- --maxWorkers=1` | 通过，5 个测试文件、14 个测试 |
| `npx tsc --noEmit` | 通过 |
| `npm run test:typecheck` | 通过 |
| `npm run lint` | 通过 |
| 最终权限迁移检查点 | 通过，5 个测试文件、63 个测试 |
| `git diff --check` | 通过；只有 Git 的 LF/CRLF 工作区提示，无空白错误 |
| OpenSpec status | 4/4 artifacts complete |
| `openspec validate rebuild-claude-security-permissions --type change --strict` | 通过 |
| 标准 OpenSpec archive | 通过；64 个 requirement 新增、47 个旧 requirement 删除，未使用 `--skip-specs` |
| 安全相关主 specs 严格校验 | 31 个 capability 全部通过，包括 20 个 change capability 与 11 个相邻旧契约迁移 |

零残留扫描同时确认 `src` 中以下旧生产符号计数均为 0：

- `ApprovalPolicy`
- `SafetyCheckResult`
- `SafetyOperation`
- `PendingGrant`
- `CallCapability`
- `WorkMode`
- `ToolPermissionResourceEvidence`
- `auto-classifier`
- `ToolAccessMetadataProvider`
- `ToolAccessMetadataPort`
- `ResourceExtractor`
- `resourceExtractor`
- `accessMetadata`

单元测试结束时 Node 报告了 Socket 上 11 个 listener 的 `MaxListenersExceededWarning`。该警告没有造成测试失败，也没有证据表明它由本次权限迁移引入，因此本 change 不以调高 listener 上限掩盖它；后续应作为独立诊断项追踪。

仓库级 `openspec validate --specs --strict` 当前统计为 97 个 capability 中 41 个通过、56 个失败；失败项是本 change 之外仍使用旧 OpenSpec 文档结构的历史规格。安全体系相关的 31 个 capability 已逐个严格通过，本次没有借机批量改写其余无关规格。

## 原生 Windows CLI 验收

| 场景 | 真实结果 |
| --- | --- |
| Manual 普通编辑 | 首次 `writeFile` 显示 Allow Once、Allow + Accept edits on、Deny 三项；Allow Once 后文件按预期落盘 |
| Manual 拒绝 | 选择 Deny 后执行前拒绝，目标文件不存在；CLI 显示“调用失败，错误结果已返回给 Agent”，不再误报“执行完毕” |
| Accept edits on | `/workmode acceptEdits` 后普通工作区编辑不再重复询问 |
| 审批内切换模式 | 选择“允许并开启 Accept edits on”后当前会话立即切换；同一会话第二次普通编辑无再次审批 |
| Plan 进入与退出 | `/workmode plan` 与 `/workmode manual` 均生效；新进程仍以 Manual 启动，证明 `/workmode` 不持久化未来默认 |
| 规则增删 | `/permissions add-rule session allow readFile` 可显示来源，随后 `remove-rule` 撤销且状态回到无规则 |
| 额外目录 | 对 `C:\Users\15229\AppData\Local\Temp\myagent-cli-additional-dir-acceptance` 选择“在此目录开启 Accept edits on”后，目录进入 session 快照，文件精确落盘且模式切换 |
| 默认 memory 写入 | 隔离用户目录中的 `topics/cli-acceptance.md` 与 `MEMORY.md` 由真实 `writeFile` 连续写入，全程无审批且模式不变 |
| custom memory 写入 | `/memory` 显示可信 custom 根；写入进入普通审批，选项明确列出完整授权目录；选择 Deny 后文件不存在 |
| `MEMORY.md` 自动注入 | 隔离用户目录启动后，模型无需工具即可回答 `index_marker: injection-index-7f31` |
| topic 按需读取 | topic 标记在首轮未出现；显式请求后真实调用 `readFile`，才读到 `topic_marker: injection-topic-9c42`，读取过程无审批 |
| memory 兄弟目录 | 对当前 `projectDataDir/state` 的写入没有继承 memory 特权，而是进入普通审批；选择 Deny 后文件不存在 |
| 管理命令 | `/permissions`、`/memory`、`/sandbox` 均由真实 CLI 执行；来源、根目录、topic 显式诊断和状态版本可见 |
| Windows sandbox | `/sandbox` 显示 `win32 / native / policy-only`，并明确说明没有 OS 级文件、网络、进程与凭据隔离，未宣称 contained |

可复核的持久会话证据：

- `C:\Users\15229\.myagent\projects\MyAgent-a5a46f919680\state\sessions\session_20260728T151952.124Z-23f6c61c-ef56-4f03-b62e-792215dda485.json`：审批内切换 Accept edits on 与同会话后续免问。
- `C:\Users\15229\.myagent\projects\MyAgent-a5a46f919680\state\sessions\session_20260728T154305.134Z-b5cfc932-72fa-467e-ba36-d241482291d0.json`：外部目录显式授权、模式切换和文件写入。

默认/custom memory 与自动注入验收均使用独立 `USERPROFILE` 或独立 custom 根。验收后相关临时文件和目录已删除，真实用户 memory 未被修改。其他 CLI 验收文件也已逐项删除。

## 归档结果

- proposal、design、tasks、exploration 和 20 个 capability delta specs 均完整。
- change 已通过标准 OpenSpec archive 流程合并到 `openspec/specs`，归档目录为 `2026-07-28-rebuild-claude-security-permissions`。
- 归档后 20 个主 capability specs 均严格校验通过。
- 额外迁移并严格校验了 `authorization-scope-boundaries`、`tool-security-category`、`session-lifecycle-hooks`、`agent-loop-lifecycle-plugin`、`brain-state-isolation`、`contract-testing`、`test-coverage`、`tool-constants`、`port-contract-isolation`、`native-tools-extension` 和 `virtual-mcp-server`，避免旧 CallCapability、ApprovalService、临时白名单和 metadata provider 契约回流。
