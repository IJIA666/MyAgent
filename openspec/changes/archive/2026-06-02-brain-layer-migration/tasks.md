## 1. 思考层基础设施迁移

- [x] 1.1 创建 `src/brain/` 目录
- [x] 1.2 将 `src/session.ts` 移动到 `src/brain/session.ts`
- [x] 1.3 创建 `src/brain/index.ts`，重新导出 `SessionManager`

<!-- checkpoint: node -e "require('fs').existsSync('src/brain/session.ts') ? process.exit(0) : process.exit(1)" -->

## 2. 依赖修复与边界调整

- [x] 2.1 修复向下依赖：更新 `src/brain/session.ts` 中对 `action` 层的导入，修正相对路径（从 `./action/index.js` 改为 `../action/index.js`）
- [x] 2.2 修复向下依赖：更新 `src/brain/session.ts` 中对 `config` 层的导入，修正相对路径（从 `./config/index.js` 改为 `../config/index.js`）
- [x] 2.3 修复外层调用：更新 `src/index.ts`，将对 `SessionManager` 的导入指向 `src/brain/index.js`
- [x] 2.4 修复外层调用：更新 `src/command.ts`，将对 `SessionManager` 的导入指向 `src/brain/index.js`

<!-- checkpoint: npx tsc --noEmit -->
