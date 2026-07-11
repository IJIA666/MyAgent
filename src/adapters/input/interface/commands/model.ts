import { ICommand, CommandContext } from './base.js';
import { theme } from '../views/theme.js';
import * as p from '@clack/prompts';
import { getModelConfig, BUILTIN_MODELS } from '../../../../config/index.js';
import { updateEnvVariable } from '../../../../config/env.js';
import { selectWithCleanCancel } from '../select.js';

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

    const modelSelect = await selectWithCleanCancel({
      message: '请选择目标大模型:',
      options: modelOptions,
      initialValue: args[0] && BUILTIN_MODELS[args[0]] ? args[0] : undefined
    });

    if (p.isCancel(modelSelect)) {
      p.cancel('已取消模型切换。');
      return;
    }

    const targetModelId = modelSelect as string;

    // ── 推理努力度选择 ──
    const reasoningSelect = await selectWithCleanCancel({
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

    // ── 保存为默认值 ──
    const saveDefault = await p.confirm({
      message: '是否将此模型设为全局默认配置？(保存至 .env)',
      initialValue: false
    });

    if (p.isCancel(saveDefault)) {
      p.cancel('已取消模型切换。');
      return;
    }

    try {
      // 构造完整配置。上下文窗口由 profile 唯一决定，用户只选模型。
      const newConfig = getModelConfig(targetModelId, {
        allowEnvModelOverride: false,
        explicitReasoningEffort: reasoningEffort as 'low' | 'medium' | 'high' | 'max' | 'disabled' | undefined
      });
      context.session.switchModel(newConfig, { reasoning_effort: reasoningEffort });

      // ── 持久化保存逻辑：先切换再保存，失败时分步报告 ──
      let persistFailed = false;
      if (saveDefault) {
        try {
          updateEnvVariable('AGENT_LLM_MODEL', targetModelId);
          updateEnvVariable('AGENT_LLM_REASONING_EFFORT', reasoningEffort);
        } catch {
          persistFailed = true;
        }
      }

      const effectiveWindow = newConfig.contextWindow;
      if (persistFailed) {
        p.outro(theme.warning(
          `当前会话已激活：${targetModelId}（provider: ${newConfig.model}，窗口: ${effectiveWindow?.toLocaleString() ?? '未知'} tokens），` +
          `但默认配置保存失败，请检查 .env 文件权限。`
        ));
      } else {
        p.outro(theme.success(
          `配置已生效！当前激活模型：${targetModelId}，provider model: ${newConfig.model}，` +
          `context window: ${effectiveWindow?.toLocaleString() ?? '未知'} tokens`
        ));
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      p.outro(theme.error(`模型切换失败: ${msg}`));
    }
  }
}
