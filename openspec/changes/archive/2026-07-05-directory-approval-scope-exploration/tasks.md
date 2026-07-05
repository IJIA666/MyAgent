## 1. 资源模型与授权载荷修正

- [x] 1.1 修改 `src/core/usecases/security/SafetyResource.ts`，新增 `{ kind: 'directory-scope'; access: 'read'; normalizedPath: string }` 联合分支
- [x] 1.2 修改 `src/core/usecases/plugins/plugin-types.ts`，让 `PendingGrant` 的会话授权资源保留 `kind`
- [x] 1.3 修改 `src/core/usecases/security/ApprovalPolicy.ts`，让 `directory-scope` 能参与资源分类、匹配和授权效果映射

<!-- checkpoint: npx tsc --noEmit --pretty -->

## 2. 工具层与资源重建对齐

- [x] 2.1 修改 `src/adapters/tools/impl/filesystem/file-system.ts` 中 `ListFilesTool.checkSafety()`，越界上报 `kind: 'directory-scope'`
- [x] 2.2 修改 `src/adapters/tools/virtual-mcp.ts` 中 `listFiles` 的资源重建逻辑，确保审批校验和工具声明一致
- [x] 2.3 明确保持 `readFile`、`grepSearch`、`globSearch`、所有写工具不变

<!-- checkpoint: npx tsc --noEmit --pretty -->

## 3. 白名单与运行时放行逻辑

- [x] 3.1 修改 `src/core/usecases/security/SecurityService.ts`，新增目录范围读白名单
- [x] 3.2 基于 `getPhysicalRealPath()` 实现目录子树命中判定
- [x] 3.3 修改 `src/core/usecases/engine/agent-loop.ts`，根据资源 kind 分流写入精确读白名单或目录范围读白名单
- [x] 3.4 修改 `src/adapters/tools/impl/base.ts` 中读路径放行逻辑，接入目录范围白名单（已通过 `hasTemporaryReadWhitelist` 的 SecurityService 升级自动覆盖）
- [x] 3.5 确认写白名单逻辑保持不变

<!-- checkpoint: npx tsc --noEmit --pretty -->

## 4. 审批文案

- [x] 4.1 修改审批文案生成逻辑，对 `directory-scope` 显示”允许读取该目录及其所有子目录”
- [x] 4.2 确认普通路径读和写权限提示文案不受影响

<!-- checkpoint: npx tsc --noEmit --pretty -->

## 5. 规格整理

- [x] 5.1 更新 `directory-scope-authorization` spec，明确 `directory-scope` 资源、会话授权载荷保留 kind、子树匹配规则、写权限隔离规则
- [x] 5.2 删除”旧格式资源默认 path”的伪兼容描述，避免与当前真实类型定义冲突

## 6. 验证

- [x] 6.1 增加自动化测试：批准 `listFiles(“abc”)` 的 `session` 后，再访问 `abc/def` 不再触发审批
- [x] 6.2 增加自动化测试：批准 `listFiles(“abc”)` 后，访问兄弟目录 `abd` 仍需审批
- [x] 6.3 增加自动化测试：目录范围读可复用到 `readFile(“abc/file.txt”)`
- [x] 6.4 增加自动化测试：目录范围读不能复用于任何写操作
- [x] 6.5 增加自动化测试：软链接或真实路径跳出授权目录时不得误命中
- [x] 6.6 增加自动化测试：`once` 不得产生目录范围授权
- [x] 6.7 手动冒烟：确认审批文案对 directory-scope 资源准确显示”允许读取该目录及其所有子目录”，且未误导成写权限或全盘授权（无需自动化覆盖）

<!-- checkpoint: npx vitest run src/core/usecases/security/ -->
