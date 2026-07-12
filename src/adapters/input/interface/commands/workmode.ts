import { ICommand, CommandContext } from './base.js';
import { theme } from '../views/theme.js';
import { ConfigPermissionMode } from '../../../../config/index.js';
import { savePermissionMode } from '../../../../adapters/tools/impl/system/terminal-config.js';
import * as p from '@clack/prompts';
import { selectWithCleanCancel } from '../select.js';

/** 普通交互向导中默认展示的四种权限模式。 */
const INTERACTIVE_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto'] as const;

/** 仅通过显式参数进入的高级权限模式。 */
const ADVANCED_PERMISSION_MODES = ['dontAsk', 'bypassPermissions'] as const;

/** 所有可被配置或通过显式参数指定的权限模式。 */
const ALL_PERMISSION_MODES = [...INTERACTIVE_PERMISSION_MODES, ...ADVANCED_PERMISSION_MODES] as const;

/**
 * 切换权限模式的 Slash 命令实现。
 *
 * 常规向导只暴露 Manual、Edit automatically、Plan 和 Auto；dontAsk 与
 * bypassPermissions 仍属于统一权限模型，但必须通过显式参数进入。
 */
export class PermissionModeCommand implements ICommand {
  name = 'workmode';
  description = '查看或修改权限模式（常规：default | acceptEdits | plan | auto；高级模式需显式指定）';

  /**
   * 执行权限模式查询或切换。
   *
   * @param args - 命令参数；为空时打开常规模式向导
   * @param context - 当前 CLI 会话上下文
   */
  async execute(args: string[], context: CommandContext): Promise<void> {
    const modeLabels: Record<ConfigPermissionMode, string> = {
      default: 'Manual - 每次编辑或高风险操作前询问',
      acceptEdits: 'Edit automatically - 自动接受文件编辑，命令仍需询问',
      plan: 'Plan - 只读探索并先提出计划',
      auto: 'Auto - 通过安全检查的操作自动批准',
      dontAsk: "Don't ask - 仅执行已预授权操作",
      bypassPermissions: 'Bypass permissions - 跳过普通询问（仅限隔离环境）',
    };

    // 无参数时只展示常规模式，避免把高级安全模式误导成日常选项。
    if (args.length === 0) {
      console.log();
      p.intro(theme.highlight('权限模式管理 (PermissionMode)'));

      const currentMode = context.session.getPermissionMode();
      console.log(theme.info(`当前权限模式：${theme.highlight(currentMode)}`));

      // 当前模式若为高级模式，则不强行映射到常规选项，避免误显示错误状态。
      const initialValue = INTERACTIVE_PERMISSION_MODES.find((mode) => mode === currentMode);
      const modeSelect = await selectWithCleanCancel({
        message: '请选择目标权限模式:',
        options: INTERACTIVE_PERMISSION_MODES.map((mode) => ({
          value: mode,
          label: modeLabels[mode],
        })),
        initialValue,
      });

      if (p.isCancel(modeSelect)) {
        p.cancel('已取消权限模式切换。');
        return;
      }

      const targetMode = modeSelect as ConfigPermissionMode;
      try {
        context.session.setPermissionMode(targetMode);
        savePermissionMode(targetMode);
        p.outro(theme.success(`配置已生效！权限模式已切换为：${targetMode}`));
      } catch (error: unknown) {
        p.outro(theme.error(`模式切换失败: ${(error as Error).message}`));
      }
      return;
    }

    // 带参数时允许显式指定高级模式，但不把它们放入普通向导。
    const rawMode = args[0].trim().toLowerCase();
    const validModes = ALL_PERMISSION_MODES.map((mode) => mode.toLowerCase());
    const modeMap: Record<string, ConfigPermissionMode> = {
      default: 'default',
      acceptedits: 'acceptEdits',
      plan: 'plan',
      auto: 'auto',
      dontask: 'dontAsk',
      bypasspermissions: 'bypassPermissions',
    };

    if (!validModes.includes(rawMode)) {
      console.log(theme.error(`[错误] 不支持的权限模式: "${args[0]}"。常规模式: default, acceptEdits, plan, auto；高级模式: dontAsk, bypassPermissions`));
      return;
    }

    const finalMode = modeMap[rawMode];
    try {
      context.session.setPermissionMode(finalMode);
      savePermissionMode(finalMode);
      console.log(theme.success(`[系统] 权限模式已成功切换为: ${theme.highlight(finalMode)}`));
    } catch (error: unknown) {
      console.log(theme.error(`[错误] 模式切换失败: ${(error as Error).message}`));
    }
  }
}
