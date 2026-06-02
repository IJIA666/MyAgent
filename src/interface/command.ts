import { Interface } from 'readline';
import * as p from '@clack/prompts';
import { SessionManager } from '../brain/index.js';
import { getModelConfig, BUILTIN_MODELS } from '../config/index.js';
import { updateEnvVariable } from '../utils/env.js';
import { theme } from './theme.js';

/**
 * 命令执行上下文接口，包含当前会话状态和交互界面
 */
export interface CommandContext {
  session: SessionManager; // 当前活跃的会话管理器实例
  rl: Interface;           // 绑定的 readline 交互接口
}

/**
 * 分发执行系统级的 Slash Command。
 *
 * @param input 原始输入字符串（以 / 开头）
 * @param context 命令执行上下文
 */
export async function dispatchCommand(input: string, context: CommandContext): Promise<void> {
  // 解析命令和参数
  const parts = input.trim().split(' ');
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);

  // 路由分发到对应的处理逻辑
  switch (command) {
    case '/model':
      // 处理模型切换命令
      await handleModelCommand(args, context);
      break;
    case '/help':
      // 处理帮助信息打印
      handleHelpCommand();
      break;
    default:
      // 未知命令处理
      console.log(theme.error(`[错误] 未知的系统指令: ${command}，输入 /help 查看帮助。`));
  }
}

/**
 * 处理大语言模型切换与配置向导逻辑。
 * 提供交互式的终端 UI 供用户选择模型和推理思考等级。
 *
 * @param args 命令行附带的参数数组
 * @param context 命令执行上下文
 */
async function handleModelCommand(args: string[], context: CommandContext): Promise<void> {

  console.log();
  p.intro(theme.highlight('模型配置向导'));

  // 组装内置模型选项供用户选择
  const modelOptions = Object.keys(BUILTIN_MODELS).map(id => ({
    value: id,
    label: id
  }));

  // 发起模型选择交互提示
  const modelSelect = await p.select({
    message: '请选择目标大模型:',
    options: modelOptions,
    // 若参数中指定了合法模型 ID，则设为初始默认选项
    initialValue: args[0] && BUILTIN_MODELS[args[0]] ? args[0] : undefined
  });

  // 检查用户是否取消了选择操作
  if (p.isCancel(modelSelect)) {
    p.cancel('已取消模型切换。');
    return;
  }

  const targetModelId = modelSelect as string;

  // 发起思考等级选项的交互提示
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

  // 询问用户是否需要将变更固化到环境变量配置中
  const saveDefault = await p.confirm({
    message: '是否将此模型设为全局默认配置？(保存至 .env)',
    initialValue: false
  });

  if (p.isCancel(saveDefault)) {
    p.cancel('已取消模型切换。');
    return;
  }

  try {
    // 拉取选定模型的详细配置
    const newConfig = getModelConfig(targetModelId);
    // 动态刷新当前会话底层的模型实例及其推理参数
    context.session.switchModel(newConfig, { reasoning_effort: reasoningEffort });

    // 如需保存默认，则更新本地的 .env 文件
    if (saveDefault) {
      updateEnvVariable('DEEPSEEK_MODEL', targetModelId);
      updateEnvVariable('DEEPSEEK_REASONING_EFFORT', reasoningEffort);
    }

    // 打印成功提示
    p.outro(theme.success(`配置已生效！当前激活模型：${targetModelId}`));
  } catch (e: unknown) {
    // 捕获异常并予以呈现
    const msg = e instanceof Error ? e.message : String(e);
    p.outro(theme.error(`模型切换失败: ${msg}`));
  }
}

/**
 * 打印系统层级命令的帮助菜单信息。
 */
function handleHelpCommand(): void {
  console.log(`\n${theme.success('可用指令列表:')}`);
  console.log(`  ${theme.highlight('/model <id>')} - 动态切换当前会话的大语言模型`);
  console.log(`  ${theme.highlight('/help')}       - 显示此帮助信息`);
  console.log(`  ${theme.highlight('exit / quit')} - 退出程序\n`);
}
