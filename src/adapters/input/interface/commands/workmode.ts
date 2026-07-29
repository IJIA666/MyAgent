import type { ICommand, CommandContext } from './base.js';
import { theme } from '../views/theme.js';
import type { ConfigPermissionMode } from '../../../../config/types.js';
import {
  getUserPermissionModeLabel,
  INTERACTIVE_PERMISSION_MODES,
} from '../../../../core/domain/permissions/permission-types.js';
import * as p from '@clack/prompts';
import { selectWithCleanCancel } from '../select.js';

/** 普通交互向导中展示的三种已交付权限模式。 */
// 使用 permission-types.ts 导出的 INTERACTIVE_PERMISSION_MODES

/**
 * 切换权限模式的 Slash 命令实现。
 *
 * 常规向导只暴露 Manual、Accept edits on 和 Plan；dontAsk 与
 * bypassPermissions 仍属于统一权限模型，但必须通过显式参数进入。
 */
export class PermissionModeCommand implements ICommand {
  name = 'workmode';
  description = '查看或修改当前会话权限模式（常规：manual | acceptEdits | plan；高级模式需显式指定）';

  /**
   * 执行权限模式查询或切换。
   *
   * @param args - 命令参数；为空时打开常规模式向导
   * @param context - 当前 CLI 会话上下文
   */
  async execute(args: string[], context: CommandContext): Promise<void> {
    /** 常规交互模式描述，按用户可见标签展示。 */
    const modeLabels: Record<string, string> = {
      default: 'Manual - 每次编辑或高风险操作前询问',
      acceptEdits: 'Accept edits on - 自动接受普通文件编辑，命令仍需询问',
      plan: 'Plan - 只读探索并先提出计划',
      dontAsk: "Don't ask - 仅执行已预授权操作",
      bypassPermissions: 'Bypass permissions - 跳过普通询问（仅限隔离环境）',
    };

    // 无参数时只展示常规模式，避免把高级安全模式误导成日常选项。
    if (args.length === 0) {
      console.log();
      p.intro(theme.highlight('权限模式管理 (PermissionMode)'));
      const currentModeLabel = getUserPermissionModeLabel(
        context.session.getPermissionMode(),
      );
      const currentMode = context.session.getPermissionMode();
      console.log(theme.info(`当前权限模式：${theme.highlight(currentModeLabel)}`));

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
        p.outro(theme.success(`当前会话权限模式已切换为：${getUserPermissionModeLabel(targetMode)}`));
      } catch (error: unknown) {
        p.outro(theme.error(`模式切换失败: ${(error as Error).message}`));
      }
      return;
    }

    // 带参数时允许显式指定高级模式，但不把它们放入普通向导。
    const rawMode = args[0].trim().toLowerCase();
    const modeMap: Record<string, ConfigPermissionMode> = {
      default: 'default',
      manual: 'default',
      acceptedits: 'acceptEdits',
      plan: 'plan',
      dontask: 'dontAsk',
      bypasspermissions: 'bypassPermissions',
    };

    if (!(rawMode in modeMap)) {
      console.log(theme.error(`[错误] 不支持的权限模式: "${args[0]}"。常规模式: manual, acceptEdits, plan；高级模式: dontAsk, bypassPermissions`));
      return;
    }

    const finalMode = modeMap[rawMode];
    try {
      context.session.setPermissionMode(finalMode);
      console.log(theme.success(`[系统] 当前会话权限模式已切换为: ${theme.highlight(getUserPermissionModeLabel(finalMode))}`));
    } catch (error: unknown) {
      console.log(theme.error(`[错误] 模式切换失败: ${(error as Error).message}`));
    }
  }
}
