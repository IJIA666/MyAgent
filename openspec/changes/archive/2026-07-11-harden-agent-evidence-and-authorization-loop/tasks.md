## 1. 统一操作副作用与 Plan 安全判定

- [x] 1.1 扩展现有工具策略契约，使可信内置工具能够基于参数报告 `read`、`write`、`unknown`、`sensitive-read`、`hardline`，复用 `SafetyOperation`，不得新增平行决策模型。
- [x] 1.2 在终端边界复用 `ShellExecutionPlan`、解包和结构校验生成可信副作用分类，确保复合连接、重定向、脚本块和未知命令不能获得 read。
- [x] 1.3 修改 Plan 策略：非敏感且可证明安全的 read 直接 pass，sensitive-read 进入受限审批，write/unknown/hardline 拒绝。
- [x] 1.4 更新终端与工具策略测试，使用多个 shell family 的只读、敏感读取、未知副作用、写入和硬红线用例验证前置判定与执行期同构。
- [x] 1.5 按项目注释规范为新增或修改的公开类型和方法补齐标准 TSDoc，私有辅助逻辑仅保留必要职责注释。

<!-- checkpoint: npx vitest run test/adapters/tools/terminal.test.ts test/core/usecases/plugins/human-approval-composition.test.ts -->

## 2. 闭合审批选择与授权消费链

- [x] 2.1 修改 `ApprovalPolicy` choice 生成逻辑，在展示前验证资源可信性、效果可映射性、当前模式适用性和后续消费能力。
- [x] 2.2 为命令授权设计结构化操作族资源，至少包含 shell family、根命令和受限参数模式；如需兼容旧 `command-prefix`，在边界集中迁移，禁止散落字符串特判。
- [x] 2.3 修改 `ApprovalEffectApplier` 与安全检查链，使 call、session、persistent 在声明适用的作用域内立即可消费，且更高优先级拒绝规则仍可覆盖长期授权。
- [x] 2.4 确保无法形成稳定操作族的命令只展示 call/deny，敏感读取只展示 call/deny，硬红线只展示 deny。
- [x] 2.5 增加审批组合与持久化回归测试，验证 UI 展示的每个长期选项在后续 run、会话或进程重启边界中真实生效，不适用选项不出现。

<!-- checkpoint: npx vitest run test/core/usecases/security/ApprovalPolicy.test.ts test/core/usecases/engine/approval-effect-applier.test.ts test/contract/tool-call-orchestration.test.ts -->

## 3. 将对象级证据账本接入真实工具结算路径

- [x] 3.1 为诊断相关内置工具建立证据解释器注册接口，优先复用现有 `parseReadFileEvidence`、`parseListFilesEvidence`、`parseCommandEvidence` 和 `DiagnosticEvidenceRecord`。
- [x] 3.2 在 AgentLoop 的 fulfilled、工具业务错误、预执行拒绝和灾难性异常结算分支统一调用证据解释器并更新对象级账本。
- [x] 3.3 移除或收敛直接覆盖单一 `evidenceLevel` 的旧状态更新路径，使回合级摘要完全由账本派生。
- [x] 3.4 修正错误合并规则：目标级 error 与其他目标的 measured 并存，同目标完整记录可替换旧 partial，但保留来源和错误审计。
- [x] 3.5 为结构化输出提供明确解析器；未注册自由文本不得仅凭通用大数字正则升级为 measured。
- [x] 3.6 补充单元与 AgentLoop 集成测试，覆盖混合成功/失败、部分转完整、自由文本数字和多工具并发结算顺序。

<!-- checkpoint: npx vitest run test/core/domain/diagnostic-guardrails.test.ts test/core/usecases/engine/agent-loop.test.ts -->

## 4. 引入跨工具的证据增益与成本收敛

- [x] 4.1 扩展 `DiagnosticTurnState`，记录每次调用的目标覆盖变化、指标新增、完整性提升、耗时、扫描条目、输出体积和失败分类。
- [x] 4.2 在 `reserveDiagnosticToolCall` 中实现连续低增益、重复目标、无依据横向扩散和总成本超限判定，保留固定次数作为辅助观测而非唯一停机条件。
- [x] 4.3 通过 ToolRegistry 能力信息判断结构化只读工具是否覆盖目标信息；只有明确的系统级缺口才允许原子 Shell 补位。
- [x] 4.4 允许 partial 结果在剩余预算内引导更窄目标测量，但禁止自动提高深度、条目、字节、时间或输出上限。
- [x] 4.5 增加磁盘诊断、日志排查和代码分析三类测试夹具，验证同一收敛算法且生产逻辑中不存在盘符、`dir` 或领域名称特判。

<!-- checkpoint: npx vitest run test/core/domain/diagnostic-guardrails.test.ts test/core/usecases/engine/agent-loop.test.ts -->

## 5. 统一批量只读工具的部分成功协议

- [x] 5.1 定义批量只读结果包络，包含成功对象、失败对象、跳过对象、截断/取消原因、覆盖范围、完整性和可选卸载明细引用。
- [x] 5.2 迁移 `listFiles` 的直接子项元数据与目录测量：单个 `stat`、权限或链接错误只降低对应对象完整性，根目标不可访问时才整体失败。
- [x] 5.3 将条件参数校验移到任何扫描之前；在工具 definition 中明确预算参数依赖，无法表达条件 required 时提供安全默认值或精确校验错误。
- [x] 5.4 为大量失败和跳过项实现按错误类型聚合与有限样本，避免部分成功协议导致上下文膨胀。
- [x] 5.5 盘点其他枚举、搜索和批量读取工具，迁移实际存在相同失败模式的调用点，不为不存在的问题扩张范围。
- [x] 5.6 增加根目标失败、单项权限失败、预算截断、取消、参数缺失和错误明细卸载测试。

<!-- checkpoint: npx vitest run test/adapters/tools/tools.test.ts test/adapters/tools/new-tools.test.ts -->

## 6. 收紧提示词与最终回答质量门禁

- [x] 6.1 修改基础提示词，要求模型直接回答当前目标，优先给出证据支持的发现、适用范围、未知项和可验证下一步，禁止常识复述、无筛选候选堆砌和模板化空泛建议。
- [x] 6.2 修改诊断动态 reminder，只注入当前相关对象的证据摘要、未覆盖范围、剩余预算、低增益原因和允许的下一步，避免注入单一全局 error 或冗长历史。
- [x] 6.3 在最终回答提交前加入确定性的“主张—证据”校验，覆盖量化值、估算、完成度、主要原因、风险等级和执行性处置结论。
- [x] 6.4 对无匹配证据的主张执行删除或明确降级，对 partial/lower-bound 自动要求下界和未覆盖说明；不得额外调用模型自评作为安全底线。
- [x] 6.5 增加提示词快照和最终回答质量测试，验证具体回答、明确未知项、建议触发条件以及无依据泛化内容的降级。

<!-- checkpoint: npx vitest run test/core/usecases/brain/prompt.test.ts test/core/usecases/engine/model-request-assembler.test.ts test/core/usecases/engine/agent-loop.test.ts -->

## 7. 通用闭环集成验收与规格一致性

- [x] 7.1 建立完整集成用例，验证 read 判定、授权消费、部分成功、证据账本、低增益停机、动态 reminder 和最终回答门禁按同一 correlationId 链路协作。
- [x] 7.2 将本次磁盘诊断作为回归夹具之一，同时加入日志排查与代码分析夹具，确认测试数据不渗透进生产分支和提示词。
- [x] 7.3 复核 `base-security` 中“只读静默放行”与 Plan 场景、审批规格和授权作用域规格的一致性，删除被本 change 替代的冲突表述和重复诊断停机需求。
- [x] 7.4 运行类型检查与相关测试，检查 proposal、design、tasks、delta specs 与实现路径一致，不以编译成功代替契约验收。

<!-- checkpoint: npx tsc --noEmit -->
<!-- checkpoint: npx vitest run test/contract test/integration -->

## 8. 运行时回归返工

- [x] 8.1 依据本 change 内的 `model-mode-awareness-boundary.md` 修正 proposal、design、`prompt-engine` 与 `system-reminder-injection` 增量规格：模型只感知完成当前任务所需的行为约束、允许能力和禁止副作用，不感知 `SecurityMode`、`WorkMode`、YOLO、审批策略、白名单优先级或副作用分类等控制平面枚举。
- [x] 8.2 删除 `model-request-assembler.ts` 中面向模型的 `SecurityMode: ${currentMode}` 注入，并把基础提示词中“当前处于 Plan”式规则改写为与内部模式名无关的能力约束；保留 ToolRegistry 工具裁剪、ToolPolicy、ApprovalPolicy 和执行期校验对会话模式的运行时消费。
- [x] 8.3 修复证据解释器与真实工具结果契约：覆盖普通 `listFiles` 返回 JSON 数组、带元数据返回对象、`wmic` 的 `FreeSpace=<number>`/`Size=<number>`、Shell 包络和部分成功包络，不得用测试专用伪结果替代生产形状。
- [x] 8.4 修复收敛计数：仅对诊断相关且应产生证据的调用计算停滞；成功获得新目标、枚举或测量必须重置相应计数，`get_current_time` 等辅助调用不得消耗证据停滞额度。
- [x] 8.5 修复对象级证据派生：局部 error 与其他目标 measured 并存时不得把整个回合摘要覆盖为 error；修正风险文本拼接中遗漏 `$` 导致结果与错误未进入高风险目标检测的问题。
- [x] 8.6 删除伪造的成本度量，接入真实 duration、itemsScanned 和输出字节数后再启用成本收敛；在此之前不得用固定 `durationMs: 0`、`itemsScanned: 1` 宣称已完成实际成本治理。
- [x] 8.7 实现任务 6.1、6.3、6.4 声明的真实能力：基础提示词加入可验收的聚焦约束，并在最终回答提交边界加入确定性的“主张—证据”质量门禁，阻止无依据释放空间估算、绝对化安全结论和泛泛候选清单。
- [x] 8.8 使用最新 `.myagent` 会话的真实序列建立回归测试：辅助调用 + 普通目录枚举 + `wmic` 测量必须形成有效证据且不得提前停机；复杂 PowerShell 仍被运行时拒绝；最终回答不得产生未测量清理项的量化估算。
- [x] 8.9 移除测试中的全局解释器手工注册和伪造 `{ entries: [...] }` 结果，改用 `buildNativeTools()` 的真实注册链与工具实际返回值，防止测试通过而组合根行为失败。
- [x] 8.10 补充非法 `ask_user_question` JSON 的回归：参数解析失败必须保留清晰中文错误，不得出现乱码兼容标签；模型下一轮提醒必须准确说明 JSON 语法错误，不得错误归因为缺少 `questions` 参数。
- [x] 8.11 修正只读自动放行事件语义：自动 pass 不得伪造 `suspend` 事件、空 choices 或包含内部模式与副作用分类的提示；用户界面与审计可记录真实判定，但模型消息不得接收控制平面细节。
- [x] 8.12 增加模型请求边界测试：不同内部工作模式下，发送给模型的消息不得出现内部模式枚举；只读约束场景仍必须包含“仅允许读取、分析和建议”等行为要求，CLI 用户界面与审计日志仍可显示真实模式。
- [x] 8.13 将 `TaskPhase` 与 `ApprovalPolicy` 的长期拆分记录为 design 后续方向，不在本 change 中新增状态维度或迁移现有 `WorkMode`，避免把本轮回归修复扩大为会话状态重构。

<!-- checkpoint: npx vitest run test/core/domain/diagnostic-guardrails.test.ts test/core/usecases/engine/model-request-assembler.test.ts test/core/usecases/engine/agent-loop.test.ts test/integration/safety-cascade-isolation.test.ts -->
<!-- checkpoint: npx tsc --noEmit -->
