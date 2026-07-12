## 新增需求

### 需求: 权限持久化与静态前缀提取 (Always Allow & Static Prefix Abstraction)
当终端引擎拦截了一个命令并向用户发起确认提问时，系统会尝试自动提取该命令的安全前缀，并将其作为“始终放行”的选项。用户若选择“始终放行 (Always Allow)”，该规则将被持久化存储 to 配置文件中（如 `.agent/allowed_commands.json`）。
- **根与子命令双重校验 (Root + Subcommand Extraction)**：系统绝不自动生成对单一根命令的通配符（如禁止提取 `git:*` 或 `npm:*`）。提取算法必须且只提取**前两段**（Root Command + Sub Command，且 Sub Command 必须为纯字母数字，不能是 `-flag` 或 `文件路径`）。
- **即时抽象放行**：例如，当拦截到 `git add src/a.ts` 时，系统自动提取出 `git add` 并询问是否放行 `git add:*`。一旦用户同意，以后所有 `git add` 开头的命令都将自动放行，无需多次融合。
- **解包剥壳比对与提取 (Unbox-based Matching & Extraction)**：在进行前缀提取（`extractSafePrefix`）与白名单规则校验（`checkSafety`）前，系统必须（MUST）先对终端命令进行递归解包剥壳（`unboxNestedCommand`），还原出其实际内核命令，再以该内核命令进行前缀抽象和白名单比对。
- **配置自动初始化**：如果 `.agent/allowed_commands.json` 配置文件不存在或内容为空，系统应当（SHALL）在本地自动写入一份常用且相对安全的规则列表（即预设模板，包含 `git status:*`、`git diff:*`、`git log:*`、`vitest:*`、`npm test:*`、`npm run test:*`）进行初始化。
- **透明审批真实核心指令告知**：在安全审查拦截挂起阶段，如果解包后的实际核心指令与原始命令行不一致，系统在返回的审批提示信息中必须（MUST）显式展示“解包后实际核心指令”，确保用户在知情的前提下进行确权审批。

#### 场景: 安全前缀的提取与放行
- **WHEN** 模型发起 `npm run build` 命令，触发安全拦截
- **THEN** 系统提取出 `npm run`，并在人工审批弹窗中提供“始终放行 npm run:*”的选项。
- **WHEN** 用户点击同意放行
- **THEN** `.agent/allowed_commands.json` 记录 `"npm run:*"`。当模型紧接着发起 `npm run lint` 时，匹配到前缀白名单自动放行。
- **WHEN** 模型接着发起 `npm publish`
- **THEN** 系统由于只匹配前缀，发现 `npm publish` 不在白名单中，必须拦截并抛出人工确认交互。

#### 场景: 解释器包裹命令下的剥壳匹配与放行
- **WHEN** 用户已经在白名单中授权了 `"npm run:*"`，此时模型通过解释器包裹发起了 `powershell -Command "npm run test"`
- **THEN** 系统在安全校验时对其进行解包剥壳，提取出内核命令 `npm run test`，比对白名单中存在匹配规则 `"npm run:*"`，进而静默自动放行执行。

#### 场景: 本地白名单配置缺失时的自动初始化预设
- **WHEN** 终端配置加载时检测到配置文件 `.agent/allowed_commands.json` 不存在
- **THEN** 系统自动在本地创建该文件并写入初始化的常用安全规则列表，随后以此预设作为运行时的首日白名单。

#### 场景: 审批弹窗披露解包后实际执行指令
- **WHEN** 模型发起了未经授权的包裹命令 `powershell -Command "npm run dev"`，触发安全拦截
- **THEN** 终端引擎将其判定为 `suspend` 挂起，且在审批弹窗中呈现 message，明确指示“外壳包装为 'powershell -Command "npm run dev"'，实际执行的核心命令为 'npm run dev'”，告知用户真实执行意图。

#### 场景: 解包后未命中白名单的拦截与告知行为
- **WHEN** 用户已在白名单中授权了 `"git status:*"`，此时模型发起了包裹命令 `powershell -Command "npm run lint"`
- **THEN** 终端引擎将其判定为只读级别命令，进行解包剥壳得到内核命令 `npm run lint`，提取安全前缀为 `npm run`。由于其未命中任何已放行的白名单前缀规则，系统将其判定为 `suspend` 挂起，且在审批弹窗中呈现 message，明确指示：“外壳包装为 'powershell -Command "npm run lint"'，实际执行的核心命令为 'npm run lint'”以触发人工确认交互。

### 需求: 动态安全工作模式 (Work Modes)

> ❌ 已删除 — 由 Claude PermissionMode 同构实现替代。旧 `Safe`、`Auto`、`YOLO`、`Plan` 枚举同时承载阶段和审批语义，已在 `claude-permission-model` 变更中移除。

**Migration:** 迁移到 `PermissionMode`（`default`、`acceptEdits`、`plan`、`auto`、`dontAsk`、`bypassPermissions`）与统一权限服务。

### 需求: Session-Scoped Permission Modes

每个会话 MUST 独立保存 `PermissionMode`，模式切换 MUST 通过统一模式管理器执行，不得使用进程级共享模式状态。

#### 场景: One session mode does not affect another session

- **WHEN** 会话 A 切换到 `bypassPermissions`，会话 B 保持 `default`
- **THEN** 会话 B 的工具调用 MUST 继续按 `default` 评估

#### 场景: Mode behavior follows Claude semantics

- **WHEN** 调用分别处于 `default`、`acceptEdits`、`plan`、`auto`、`dontAsk` 或 `bypassPermissions`
- **THEN** 系统 MUST 按对应 Claude 权限行为产生最终决策
