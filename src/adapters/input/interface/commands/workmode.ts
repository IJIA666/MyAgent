import { ICommand, CommandContext } from './base.js';
import { theme } from '../views/theme.js';
import { ConfigPermissionMode } from '../../../../config/index.js';
import { savePermissionMode } from '../../../../adapters/tools/impl/system/terminal-config.js';
import * as p from '@clack/prompts';
import { selectWithCleanCancel } from '../select.js';

/**
 * 切换智能体权限模式（PermissionMode）的 Slash 命令类实现。
 *
 * Claude Code 同构的权限模式：
 * - default: 默认模式，按规则需确认的操作进入询问
 * - acceptEdits: 自动接受文件编辑和常见文件系统操作
 * - plan: 只读计划模式，不允许源文件编辑
 * - auto: 使用安全分类器自动批准低风险调用
 * - dontAsk: 将未预授权的 ask 转为 deny
 * - bypassPermissions: 跳过普通询问，但显式规则仍生效
 */
export class WorkModeCommand implements ICommand {
  name = 'workmode';
  description = '查看或修改当前的权限模式 (default | acceptEdits | plan | auto | dontAsk | bypassPermissions)';

  async execute(args: string[], context: CommandContext): Promise<void> {
    const modeLabels: Record<string, string> = {
      default: 'Default - 按规则确认',
      acceptEdits: 'Edit Automatically - 自动允许编辑',
      plan: 'Plan - 只读探索模式',
      auto: 'Auto - 自动分类审批',
      dontAsk: "Don't Ask - 不询问直接拒绝",
      bypassPermissions: 'Bypass Permissions - 绕过询问',
    };

    // 1. 无参状态：自动拉起 Clack 二级单选交互向导
    if (args.length === 0) {
      console.log();
      p.intro(theme.highlight('权限模式管理 (PermissionMode)'));

      const currentMode = context.session.getPermissionMode();
      console.log(theme.info(`当前权限模式为: ${theme.highlight(currentMode)}`));

      const modeSelect = await selectWithCleanCancel({
        message: '请选择目标权限模式:',
        options: (['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'] as const).map((m) => ({
          value: m,
          label: modeLabels[m],
        })),
        initialValue: currentMode
      });

      if (p.isCancel(modeSelect)) {
        p.cancel('已取消权限模式切换。');
        return;
      }

      const targetMode = modeSelect as ConfigPermissionMode;
      try {
        // 同步修改 Session 状态，供智能体气泡和工具过滤读取
        context.session.setPermissionMode(targetMode);
        // 同步持久化
        savePermissionMode(targetMode);
        p.outro(theme.success(`配置已生效！权限模式已切换为：${targetMode}`));
      } catch (e: unknown) {
        p.outro(theme.error(`模式切换失败: ${(e as Error).message}`));
      }
      return;
    }

    // 2. 带参状态：直接在控制台静默校验并热切换
    const rawMode = args[0].trim().toLowerCase();
    const validModes = ['default', 'acceptEdits', 'plan', 'auto', 'dontask', 'bypasspermissions'];
    const modeMap: Record<string, ConfigPermissionMode> = {
      default: 'default',
      acceptedits: 'acceptEdits',
      plan: 'plan',
      auto: 'auto',
      dontask: 'dontAsk',
      bypasspermissions: 'bypassPermissions',
    };

    if (!validModes.includes(rawMode)) {
      console.log(theme.error(`[错误] 不支持的权限模式: "${args[0]}"。可选: default, acceptEdits, plan, auto, dontAsk, bypassPermissions`));
      return;
    }

    const finalMode = modeMap[rawMode];
    try {
      context.session.setPermissionMode(finalMode);
      savePermissionMode(finalMode);
      console.log(theme.success(`[系统] 权限模式已成功切换为: ${theme.highlight(finalMode)}。`));
    } catch (e: unknown) {
      console.log(theme.error(`[错误] 切换模式失败: ${(e as Error).message}`));
    }
  }
}
