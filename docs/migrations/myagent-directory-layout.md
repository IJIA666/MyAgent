# MyAgent 目录布局迁移指南

## 概述

MyAgent 统一了配置与运行数据的目录布局。旧的 `.agent/` 目录已被移除，运行数据从 workspace 下移至 `~/.myagent/projects/<workspace-key>/`。

此次迁移是**零兼容**的：新版本只读取新路径，不双读、不双写、不自动删除旧目录。

---

## 旧布局 → 新布局映射

| 旧路径 | 新路径 | 说明 |
|--------|--------|------|
| `<workspace>/.agent/config.json` | `<workspace>/.myagent/settings.json` | 项目共享配置（可提交） |
| — | `<workspace>/.myagent/settings.local.json` | 项目本机覆盖（**不可提交**，已加入 `.gitignore`） |
| `<workspace>/.agent/global_rules.md` | `~/.myagent/rules/` 或 `<workspace>/.myagent/rules/` | 按归属迁移到用户或项目 rules 目录 |
| `<workspace>/.agent/rules/guize.md` | `~/.myagent/rules/` 或 `<workspace>/.myagent/rules/` | 同上 |
| `<workspace>/.agent/skills/` | `~/.myagent/skills/` 或 `<workspace>/.myagent/skills/` | 按归属迁移到用户或项目 skills 目录 |
| `<workspace>/.agent/allowed_commands.json` | **已废弃，不再读取** | 权限规则写入 `<workspace>/.myagent/settings.local.json` 的 `permission.allow` 字段 |
| `<workspace>/.myagent/run.log` | `~/.myagent/projects/<key>/logs/run.log` | 自动迁移，无需手动操作 |
| `<workspace>/.myagent/sessions/` | `~/.myagent/projects/<key>/state/sessions/` | 旧会话文件需手动复制到新目录 |
| `<workspace>/.myagent/traces/` | `~/.myagent/projects/<key>/logs/traces/` | trace + audit 分离到 `logs/traces` 和 `logs/audits` |
| `<workspace>/.myagent/browser-session/` | `~/.myagent/projects/<key>/state/browser/` | 浏览器登录状态 |
| `<workspace>/.myagent/screenshots/` | `~/.myagent/projects/<key>/artifacts/screenshots/` | 截图文件 |
| `<workspace>/.myagent/tool-outputs/` | `~/.myagent/projects/<key>/artifacts/tool-outputs/` | 工具输出产物 |
| `<workspace>/.myagent/backups/` | `~/.myagent/projects/<key>/tmp/backups/` | 临时备份 |

---

## settings 字段合并示例

### 旧 `.agent/config.json`
```json
{
  "permissionMode": "acceptEdits",
  "defaultShellFamily": "posix"
}
```

### 新 settings 分层

用户级 `~/.myagent/settings.json`：
```json
{
  "version": 1,
  "permission": { "defaultMode": "default" }
}
```

项目级 `<workspace>/.myagent/settings.json`：
```json
{
  "version": 1,
  "terminal": { "defaultShellFamily": "posix" }
}
```

项目本机 `<workspace>/.myagent/settings.local.json`：
```json
{
  "version": 1,
  "permission": {
    "defaultMode": "acceptEdits",
    "allow": [{ "toolName": "PowerShell", "ruleContent": "Get-ChildItem" }]
  }
}
```

**合并结果**：
- `permission.defaultMode` → `acceptEdits`（来自项目本机 > 用户）
- `terminal.defaultShellFamily` → `posix`（来自项目 > 默认）
- `permission.allow` → `[{ "toolName": "PowerShell", "ruleContent": "Get-ChildItem" }]`（来自项目本机）

---

## 重要说明

1. **旧数据不会自动删除**。系统只读取新路径，旧文件保留在原位供人工处理。

2. **workspace 移动或改名后生成新 key**。workspace key 基于规范化绝对路径的 basename + SHA-256 前缀生成。移动 workspace 后旧运行数据不会自动跟随。如需保留，手动将 `~/.myagent/projects/<旧key>/` 复制为 `~/.myagent/projects/<新key>/`。

3. **回滚到旧版本时需要反向迁移**。新版本只写新路径，回滚到旧版本后旧版本仍读取旧 `.agent/` 和旧 `.myagent/` 路径。如果在新版本运行期间修改了 settings 或 rules/skills，回滚前需要把新位置的文件复制回旧位置：
   - `<workspace>/.myagent/settings.json` → `<workspace>/.agent/config.json`
   - `<workspace>/.myagent/settings.local.json` → 旧版本无对应位置，需手动合并
   - `<workspace>/.myagent/rules/` → `<workspace>/.agent/rules/` + `.agent/global_rules.md`
   - `<workspace>/.myagent/skills/` → `<workspace>/.agent/skills/`
