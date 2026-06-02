## 1. 基础配置与持久化工具层

- [x] 1.1 安装依赖 `@clack/prompts`，因为原生的 REPL 是基于 Node `readline`，无需更换核心依赖库。
- [x] 1.2 创建 `src/utils/env.ts`，实现基于正则的安全配置写入函数（替换 `^DEEPSEEK_MODEL=.*`）。

<!-- checkpoint: npx tsc --noEmit -->

## 2. 核心状态层改造 (Config & Session)

- [x] 2.1 修改 `src/config.ts` 中的 `ModelProfile` 接口定义，使 `buildExtraPayload` 接受可选参数 `options`，并在配置字典中应用动态装配（如读取 `options.reasoning_effort`）。
- [x] 2.2 修改 `src/session.ts`，让 `switchModel` 接受额外的 `options`，并保存在 session 实例中，供后续生成 payload 时使用。

<!-- checkpoint: npx tsc --noEmit -->

## 3. UI 交互层集成 (Command Router)

- [x] 3.1 改造 `src/command.ts` 的 `handleModelCommand`，当输入 `/model` 时暂停常规输出。
- [x] 3.2 使用 `@clack/prompts` 构建包含“模型选择”、“思考等级”与“是否持久化为默认”的分步互动表单。
- [x] 3.3 根据表单交互结果，调用 `session.switchModel` 更新运行时上下文，并在需要持久化时调用 `src/utils/env.ts`。

<!-- checkpoint: npx tsc --noEmit -->

## 4. 主引擎提示符更新 (REPL 主入口)

- [x] 4.1 在 `src/index.ts` 中暴露用于重置 Prompt 字符串的能力，使其能够动态包含当前 Session 的模型名称（如 `用户 [deepseek-v4-pro] >`）。
- [x] 4.2 梳理主控流在响应完 Slash Command 后，正确恢复 `rl.prompt()` 并刷新显示内容。

## 5. [Amend 修正] API 规范与副作用修复

- [x] 5.1 修改 `config.ts` 中的 thinking payload 格式为嵌套的 `thinking: { type: "enabled" }`。
- [x] 5.2 修正思考等级选项，剔除无效兼容值，仅保留 `high` 和 `max`，并将缺省值设为 `high`。
- [x] 5.3 修改 `command.ts` 同步将 `DEEPSEEK_REASONING_EFFORT` 写入 `.env` 文件。
- [x] 5.4 在 `.env.example` 补充 `DEEPSEEK_REASONING_EFFORT` 示例。
- [x] 5.5 彻底重构 `index.ts` 主流逻辑，在调起向导时主动调用 `rl.close()` 释放 `stdin` 控制权，彻底解决按键残留与乱码。

<!-- checkpoint: npm run lint && npx tsc --noEmit -->
