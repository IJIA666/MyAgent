## 改造原因

在之前的清理工作区测试中，系统暴露了严重的安全防护不对称漏斗：
1. **沙箱逃逸漏洞**：高层文件 API（如 `readFile`, `writeFile`）虽然通过前缀字符串匹配执行了沙箱限制，但终端命令行 `execute_command` 没有受到同等的沙箱边界限制。智能体可以轻易地通过 PowerShell 命令行执行绝对路径删改操作，完全绕过文件 API 的拦截规则。
2. **工作区漂移风险**：工作区路径采用相对路径 `.`，极易因启动目录（cwd）漂移而偏离预定边界。并且对于符号链接和挂载点（Junction）缺乏物理展开解析，容易被恶意穿越。
3. **读写分析与审批细粒度缺失**：智能体对文件操作无读写分类控制，无法实现配置只读等安全机制；此外，系统缺乏交互式审批提问（Ask）降级卡关机制，在用户误导或强行施压下容易产生顺从并执行高危操作。

因此，亟需对工作区绝对路径执行物理锁定、对文件读写权限进行解耦隔离、并在终端高危指令及路径溢出时建立智能降级卡关机制，从而筑牢底座安全边界。

## 变更内容

1. **工作区物理路径锁定**：废弃 `.env` 中的相对路径 `.`，在初始化时通过系统底层的物理展开（`realpath`）将其锁死为绝对物理路径，屏蔽任何相对路径偏移与虚拟映射绕过。
2. **路径校验读写分离**：重构路径验证器，针对只读和可写操作区分拦截，在 `secureResolvePath` 的基础上拆分为 `secureResolveReadPath` 与 `secureResolveWritePath`，实现细粒度的文件权限拦截。
3. **终端特定 Shell 别名拦截与安全降级**：放弃在 Windows 平台使用 Bash 特化的 `shell-quote`。对于终端执行，在 `base.ts` 中定义统一的 `ToolConstants` 常量类以消除魔法字符串。引入轻量级正则，拦截 `Remove-Item`、`del`、`rd`、`rm` 等破坏性命令与常见别名。除了明确安全的只读白名单指令外，凡是包含写倾向、管道混写或未识别的指令，一律强制安全降级为 `behavior: 'ask'` 提问，杜绝别名混淆。
4. **动态阻断与人工卡关（Ask）**：升级 `HumanApprovalPlugin`。在文件 API 越界或终端执行高危写盘指令时，挂起当前执行流并拉起人工审批提问。经用户确认后动态在 Session 内存中追加临时白名单，而非直接 Crash 中断任务，达成灵活性与安全性双赢。

## 业务能力

### 新增业务能力
- 无（本次改造属于智能体底座的底层安全重构与防御机制升级，不涉及新增业务契约能力）

### 修改业务能力
- 无（不涉及业务 spec 层面的契约改动）

## 影响范围

- **`src/action/native-tools/base.ts`**：声明统一的 `ToolConstants` 常量类；重构工作区初始化逻辑与路径安全验证函数，引入 `fs.realpathSync` 物理绝对路径解析，新增读写隔离路径校验器。
- **`src/action/virtual-mcp.ts`**：重构本地工具分发层，使用 `ToolConstants` 静态常量替代硬编码魔法字符串。
- **`src/action/native-tools/file-system.ts`**：重构 `readFileTool`, `editFileTool`, `writeFileTool`, `listFilesTool` 等文件 API，根据其读写意图调用不同的路径拦截器。
- **`src/action/native-tools/terminal-guard.ts`**：定义 `DANGEROUS_WRITE_COMMAND_REGEX` 及 `checkCommandSafetyLevel`，并重构终端 `validateCwd` 方法，保证执行目录经过 physical realpath 的强校验。
- **`src/brain/plugins/HumanApprovalPlugin.ts`**：重构审批挂起插件，加入基于能力特征集（`ToolConstants` 静态成员）的卡关判断，并支持通过 UI 交互向用户动态申请越界临时权限。
