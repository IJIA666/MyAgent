import { ICommand, CommandContext } from './base.js';
import { theme } from '../views/theme.js';
import { setWorkMode as setTerminalWorkMode, WorkMode } from '../../../../adapters/tools/impl/system/terminal-config.js';
import * as p from '@clack/prompts';

/**
 * 切换智能体安全执行工作模式的 Slash 命令类实现
 */
export class WorkModeCommand implements ICommand {
  name = 'workmode';
  description = '查看或修改当前的安全执行工作模式 (Safe | Auto | YOLO | Plan)';

  async execute(args: string[], context: CommandContext): Promise<void> {
    const sessionContext = context.session.getContext();
    
    // 1. 无参状态：自动拉起 Clack 二级单选交互向导
    if (args.length === 0) {
      console.log();
      p.intro(theme.highlight('安全模式管理'));
      
      const currentMode = sessionContext.getWorkMode();
      console.log(theme.info(`当前安全工作模式为: ${theme.highlight(currentMode)}`));
      
      const modeSelect = await p.select({
        message: '请选择目标安全执行工作模式:',
        options: [
          { value: 'Safe', label: 'Safe (每次执行写操作命令都必须人工确认)' },
          { value: 'Auto', label: 'Auto (匹配白名单放行，否则人工确认，默认)' },
          { value: 'YOLO', label: 'YOLO (直接放行所有命令，高度风险)' },
          { value: 'Plan', label: 'Plan (只读模式，物理隔离屏蔽写操作工具)' }
        ],
        initialValue: currentMode
      });

      if (p.isCancel(modeSelect)) {
        p.cancel('已取消安全模式切换。');
        return;
      }

      const targetMode = modeSelect as WorkMode;
      try {
        // 同步修改 Session 绑定的 Context 状态，供智能体气泡和工具过滤读取
        sessionContext.setWorkMode(targetMode);
        // 同步修改底层全局配置状态，供本地工具运行期安全判定拦截
        setTerminalWorkMode(targetMode);
        p.outro(theme.success(`配置已生效！安全模式已切换为：${targetMode}`));
      } catch (e: unknown) {
        p.outro(theme.error(`模式切换失败: ${(e as Error).message}`));
      }
      return;
    }

    // 2. 带参状态：直接在控制台静默校验并热切换
    const targetMode = args[0].trim();
    let upperMode = targetMode.charAt(0).toUpperCase() + targetMode.slice(1).toLowerCase();
    if (upperMode.toLowerCase() === 'yolo') {
      upperMode = 'YOLO';
    }
    const finalMode = upperMode as WorkMode;
    
    if (!['Safe', 'Auto', 'YOLO', 'Plan'].includes(finalMode)) {
      console.log(theme.error(`[错误] 不支持的工作模式: "${targetMode}"。可选的模式有: Safe, Auto, YOLO, Plan`));
      return;
    }

    try {
      sessionContext.setWorkMode(finalMode);
      setTerminalWorkMode(finalMode);
      console.log(theme.success(`[系统] 安全执行工作模式已成功切换为: ${theme.highlight(finalMode)}。`));
    } catch (e: unknown) {
      console.log(theme.error(`[错误] 切换模式失败: ${(e as Error).message}`));
    }
  }
}
