## 新增需求

### 需求: 权限持久化与静态前缀提取 (Always Allow & Static Prefix Abstraction)
当终端引擎拦截了一个命令并向用户发起确认提问时，系统会尝试自动提取该命令的安全前缀，并将其作为“始终放行”的选项。用户若选择“始终放行 (Always Allow)”，该规则将被持久化存储到配置文件中（如 `.agent/allowed_commands.json`）。
- **根与子命令双重校验 (Root + Subcommand Extraction)**：系统绝不自动生成对单一根命令的通配符（如禁止提取 `git:*` 或 `npm:*`）。提取算法必须且只提取**前两段**（Root Command + Sub Command，且 Sub Command 必须为纯字母数字，不能是 `-flag` 或 `文件路径`）。
- **即时抽象放行**：例如，当拦截到 `git add src/a.ts` 时，系统自动提取出 `git add` 并询问是否放行 `git add:*`。一旦用户同意，以后所有 `git add` 开头的命令都将自动放行，无需多次融合。

#### 场景: 安全前缀的提取与放行
- **WHEN** 模型发起 `npm run build` 命令，触发安全拦截
- **THEN** 系统提取出 `npm run`，并在人工审批弹窗中提供“始终放行 npm run:*”的选项。
- **WHEN** 用户点击同意放行
- **THEN** `.agent/allowed_commands.json` 记录 `"npm run:*"`。当模型紧接着发起 `npm run lint` 时，匹配到前缀白名单自动放行。
- **WHEN** 模型接着发起 `npm publish`
- **THEN** 系统由于只匹配前缀，发现 `npm publish` 不在白名单中，必须拦截并抛出人工确认交互。

### 需求: 动态安全工作模式 (Work Modes)
终端引擎必须支持多种工作环境模式的切换（例如 Safe 模式每次都问，Auto 模式根据白名单放行，YOLO 模式则全部放行无视风险）。系统需要在命令放行前，先核对当前的工作模式以决定安全策略。

#### 场景: 在不同模式下的命令执行策略
- **WHEN** 系统处于 YOLO 工作模式下，模型发起了未经白名单授权的命令
- **THEN** 终端引擎跳过安全交互提问，自动放行命令执行。
- **WHEN** 系统处于 Safe 工作模式下，模型发起了已经在白名单中的受信任命令
- **THEN** 终端引擎依然忽略白名单，强制发起人工确认交互。
