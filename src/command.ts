import { Interface } from 'readline';
import * as p from '@clack/prompts';
import { SessionManager } from './session.js';
import { getModelConfig, BUILTIN_MODELS } from './config.js';
import { updateEnvVariable } from './utils/env.js';

const COLOR_RESET = '\x1b[0m';
const COLOR_YELLOW = '\x1b[33m';
const COLOR_RED = '\x1b[31m';
const COLOR_GREEN = '\x1b[32m';

export interface CommandContext {
  session: SessionManager;
  rl: Interface;
}

/**
 * 分发执行系统级的 Slash Command。
 *
 * @param input 原始输入字符串（以 / 开头）
 * @param context 命令执行上下文
 */
export async function dispatchCommand(input: string, context: CommandContext): Promise<void> {
  const parts = input.trim().split(' ');
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);

  switch (command) {
    case '/model':
      await handleModelCommand(args, context);
      break;
    case '/help':
      handleHelpCommand();
      break;
    default:
      console.log(`${COLOR_RED}[错误] 未知的系统指令: ${command}，输入 /help 查看帮助。${COLOR_RESET}`);
  }
}

async function handleModelCommand(args: string[], context: CommandContext): Promise<void> {

  console.log();
  p.intro(`${COLOR_YELLOW}模型配置向导${COLOR_RESET}`);

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

    p.outro(`${COLOR_GREEN}配置已生效！当前激活模型：${targetModelId}${COLOR_RESET}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    p.outro(`${COLOR_RED}模型切换失败: ${msg}${COLOR_RESET}`);
  }
}

function handleHelpCommand(): void {
  console.log(`\n${COLOR_GREEN}可用指令列表:${COLOR_RESET}`);
  console.log(`  ${COLOR_YELLOW}/model <id>${COLOR_RESET} - 动态切换当前会话的大语言模型`);
  console.log(`  ${COLOR_YELLOW}/help${COLOR_RESET}       - 显示此帮助信息`);
  console.log(`  ${COLOR_YELLOW}exit / quit${COLOR_RESET} - 退出程序\n`);
}
