## 改造原因

当前问题已经很明确：当智能体连续浏览存在层级关系的目录时，例如 `a/` -> `a/b/` -> `a/b/c/`，系统会逐层重复申请读审批。

这不是一个抽象的“权限系统体验不好”问题，而是当前目录浏览语义和授权落库语义不一致：

- `listFiles("a")` 的真实意图是“允许继续浏览目录 `a` 及其子树”。
- 当前实现记录的却是“允许读取精确路径 `a`”。
- 因此继续访问 `a/b`、`a/b/c` 时，会被误判成新的资源申请。

竞品调研可以支持本次改造方向，但当前制品的表述过度了。更稳妥的结论应当是：常见 Agent/CLI 通常会把“目录浏览批准”理解为对该目录树的一次性只读放行，而不是每深入一层就再次确认。这里没有必要宣称“所有主流实现完全一致”。

## 变更内容

1. **仅针对 `listFiles` 引入目录子树只读授权**：本次 change 只解决“目录逐层浏览重复审批”这一个问题，不把 `globSearch`、`grepSearch` 一并纳入。
2. **新增显式资源类型 `directory-scope`**：在 `SafetyResource` 中新增一个新的判别分支，用于表达“允许读取某目录及其子目录”，并且仅允许与 `read` 组合使用。
3. **修正会话授权载荷**：当前 `session` grant 在落库前会丢失资源 kind，本次必须一并修正，否则 `directory-scope` 无法真正生效。
4. **读白名单支持目录范围命中**：`SecurityService` 在保留精确路径读白名单的同时，新增目录范围读白名单；读校验时先查精确路径，再查目录范围。
5. **写权限保持现状**：写白名单和写路径安全解析逻辑不变，目录范围读授权不得放大为任何写权限。
6. **审批文案显式展示范围**：当资源为 `directory-scope` 时，审批提示要明确表达“允许读取 `{path}` 及其子目录”。

## 业务能力

### 新增业务能力

- `directory-scope-authorization`：允许对 `listFiles` 这类目录浏览操作授予“目录及其子树”的只读授权，消除逐层重复审批。

### 修改业务能力

- 无。

本次 change 是单一新增能力，不混入其他搜索工具的授权语义调整。

## 影响范围

- **影响模块**：
  - `src/core/usecases/security/SafetyResource.ts`
  - `src/core/usecases/plugins/plugin-types.ts`
  - `src/core/usecases/security/ApprovalPolicy.ts`
  - `src/core/usecases/security/SecurityService.ts`
  - `src/core/usecases/engine/agent-loop.ts`
  - `src/adapters/tools/impl/filesystem/file-system.ts`
  - `src/adapters/tools/virtual-mcp.ts`
  - `src/adapters/tools/impl/base.ts`
- **影响行为**：
  - `listFiles` 在 `session` / `always` 下的审批结果改为对子目录继续生效
  - `readFile`、所有写操作、`globSearch`、`grepSearch` 行为保持现状
- **风险控制**：
  - `directory-scope` 只允许 `read`
  - 子树判断必须基于物理真实路径
  - 本次 change 不扩大到其他工具，避免把多个未统一语义的边界绑在一起
