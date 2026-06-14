import { ICommand, CommandContext } from './base.js';
import { theme } from '../../utils/theme.js';
import * as p from '@clack/prompts';
import { getModelConfig, BUILTIN_MODELS } from '../../config/index.js';
import { updateEnvVariable } from '../../utils/env.js';

export class ModelCommand implements ICommand {
  name = 'model';
  description = '动态切换当前会话的大语言模型';

  async execute(args: string[], context: CommandContext): Promise<void> {
    console.log();
    p.intro(theme.highlight('模型配置向导'));

    const modelOptions = Object.keys(BUILTIN_MODELS).map(id => ({
      value: id,
      label: id
    }));

    const modelSelect = await p.select({
      message: '请选择目标大模型:',
      options: modelOptions,
      initialValue: args[0] && BUILTIN_MODELS[args[0]] ? args[0] : undefined
    });

    if (p.isCancel(modelSelect)) {
      p.cancel('已取消模型切换。');
      return;
    }

    const targetModelId = modelSelect as string;

    const reasoningSelect = await p.select({
      message: '请选择思考等级 (Reasoning Effort):',
      options: [
        { value: 'max', label: 'Max (最高推理，适合复杂 Agent 任务)' },
        { value: 'high', label: 'High (高强度推理，普通请求默认)' },
        { value: 'disabled', label: 'Disabled (关闭思考模式)' }
      ],
      initialValue: 'high'
    });

    if (p.isCancel(reasoningSelect)) {
      p.cancel('已取消模型切换。');
      return;
    }

    const reasoningEffort = reasoningSelect as string;

    const saveDefault = await p.confirm({
      message: '是否将此模型设为全局默认配置？(保存至 .env)',
      initialValue: false
    });

    if (p.isCancel(saveDefault)) {
      p.cancel('已取消模型切换。');
      return;
    }

    try {
      const newConfig = getModelConfig(targetModelId);
      context.session.switchModel(newConfig, { reasoning_effort: reasoningEffort });

      if (saveDefault) {
        updateEnvVariable('DEEPSEEK_MODEL', targetModelId);
        updateEnvVariable('DEEPSEEK_REASONING_EFFORT', reasoningEffort);
      }

      p.outro(theme.success(`配置已生效！当前激活模型：${targetModelId}`));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      p.outro(theme.error(`模型切换失败: ${msg}`));
    }
  }
}
