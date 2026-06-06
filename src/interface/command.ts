import { Interface } from 'readline';
import * as p from '@clack/prompts';
import { SessionManager } from '../brain/index.js';
import { getModelConfig, BUILTIN_MODELS, updateMcpServerStatus } from '../config/index.js';
import { updateEnvVariable } from '../utils/env.js';
import { theme } from './theme.js';
import { redrawHistory } from './cli.js';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * 命令执行上下文接口，包含当前会话状态和交互界面
 */
export interface CommandContext {
  session: SessionManager; // 当前活跃的会话管理器实例
  rl: Interface;           // 绑定的 readline 交互接口
}

export interface CommandResult {
  transientSkillContent?: string;
  userMessage?: string;
}

/**
 * 分发执行系统级的 Slash Command。
 *
 * @param input 原始输入字符串（以 / 开头）
 * @param context 命令执行上下文
 */
export async function dispatchCommand(input: string, context: CommandContext): Promise<CommandResult | void> {
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
    case '/rollback':
      // 处理内存上下文回滚命令
      handleRollbackCommand(args, context);
      break;
    case '/history':
      // 查看历史会话记录
      await handleHistoryCommand();
      break;
    case '/mcp':
      // 处理 MCP 开关动态配置
      await handleMcpCommand(args, context);
      break;
    case '/tool':
      // 查看可用工具清单
      await handleToolCommand(args, context);
      break;
    case '/resume':
      // 恢复指定的历史会话
      await handleResumeCommand(args, context);
      break;
    case '/help':
      // 处理帮助信息打印
      handleHelpCommand();
      break;
    case '/skill':
      // 处理技能相关操作并返回动态挂载数据
      return await handleSkillCommand(args, context);
    default:
      // 未知命令处理
      console.log(theme.error(`[错误] 未知的系统指令: ${command}，输入 /help 查看帮助。`));
  }
}

import { loadSkills, loadSkillContent } from '../brain/contextLoader.js';

/**
 * 处理单次动态技能注入操作。
 * 
 * @param args 命令行附带的参数数组
 * @param context 命令执行上下文
 */
async function handleSkillCommand(args: string[], context: CommandContext): Promise<CommandResult | void> {
  const skillName = args[0]?.toLowerCase();

  if (!skillName || skillName === 'list') {
    const allSkills = loadSkills();
    console.log();
    if (allSkills.length === 0) {
      console.log(theme.info('当前系统未发现任何可用技能。'));
      return;
    }
    console.log(theme.highlight('发现如下可用技能：'));
    allSkills.forEach(s => {
      console.log(`- ${theme.highlight(s.name)}: ${s.description}`);
    });
    console.log(theme.info('\n提示: 使用 /skill <name> <task> 语法临时调用指定技能。'));
    return;
  }

  const skillContent = loadSkillContent(skillName);
  if (!skillContent) {
    console.log(theme.error(`[错误] 未找到名为 "${skillName}" 的技能文件。`));
    return;
  }

  const task = args.slice(1).join(' ');
  if (!task) {
    console.log(theme.error(`[错误] 已选定技能 "${skillName}"，但未提供具体任务。\n用法: /skill ${skillName} 帮我执行具体操作...`));
    return;
  }

  return {
    transientSkillContent: skillContent,
    userMessage: task
  };
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
 * 处理回滚命令，丢弃指定轮次的历史记忆上下文。
 * 
 * @param args 命令行附带的参数数组
 * @param context 命令执行上下文
 */
function handleRollbackCommand(args: string[], context: CommandContext): void {
  // 默认回滚 1 轮
  let turns = 1;
  if (args.length > 0) {
    const parsed = parseInt(args[0], 10);
    if (!isNaN(parsed) && parsed > 0) {
      turns = parsed;
    } else {
      console.log(theme.error('[错误] 请输入有效的正整数作为回滚轮数（如：/rollback 2）。'));
      return;
    }
  }

  context.session.rollback(turns);

  // 执行清屏并重绘剩下的有效记忆，抹除被回退对话在终端的显示
  redrawHistory(context.session);
}

/**
 * 打印系统层级命令的帮助菜单信息。
 */
function handleHelpCommand(): void {
  console.log(`\n${theme.success('可用指令列表:')}`);
  console.log(`  ${theme.highlight('/')}               - 唤起交互式全屏操作菜单 (推荐)`);
  console.log(`  ${theme.highlight('/skill <name> <task>')} - 单次临时调用指定技能执行任务`);
  console.log(`  ${theme.highlight('/model <id>')}       - 动态切换当前会话的大语言模型`);
  console.log(`  ${theme.highlight('/rollback [N]')}     - 回滚前 N 轮历史上下文记忆（默认 1 轮）`);
  console.log(`  ${theme.highlight('/history')}          - 查看保存的历史会话列表`);
  console.log(`  ${theme.highlight('/resume <id>')}      - 恢复指定的历史会话上下文`);
  console.log(`  ${theme.highlight('/mcp <list|enable|disable> [name]')} - 管理与查阅 MCP 扩展服务`);
  console.log(`  ${theme.highlight('/tool list')}          - 查看当前已挂载的可用工具清单`);
  console.log(`  ${theme.highlight('/help')}             - 显示此帮助信息`);
  console.log(`  ${theme.highlight('exit / quit')}       - 退出程序`);
  console.log(`\n${theme.success('快捷键支持:')}`);
  console.log(`  ${theme.highlight('双击 ESC')} - [生成中] 中断响应流；[空闲时] 单步回滚上一轮对话\n`);
}

/**
 * 扫描并打印所有持久化的历史会话文件列表，按修改时间倒序排列。
 */
async function handleHistoryCommand(): Promise<void> {
  const dir = path.join(process.cwd(), '.myagent/sessions');
  try {
    const files = await fs.readdir(dir);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    if (jsonFiles.length === 0) {
      console.log(theme.info('[系统] 暂无任何历史会话记录。'));
      return;
    }

    console.log(`\n${theme.success('历史会话列表:')}`);

    // 获取文件的修改时间并排序
    const fileStats = await Promise.all(jsonFiles.map(async file => {
      const stats = await fs.stat(path.join(dir, file));
      return { file, mtime: stats.mtimeMs, mtimeDate: stats.mtime };
    }));

    fileStats.sort((a, b) => b.mtime - a.mtime);

    for (const fsObj of fileStats) {
      const id = fsObj.file.replace('.json', '');
      const dateStr = fsObj.mtimeDate.toLocaleString();
      console.log(`  ${theme.highlight(id)}  -  ${theme.dim(dateStr)}`);
    }
    console.log(`\n使用 ${theme.highlight('/resume <id>')} 恢复指定的会话。\n`);
  } catch {
    console.log(theme.info('[系统] 暂无任何历史会话记录。'));
  }
}

/**
 * 读取指定的会话配置文件并覆盖当前内存的 messageHistory。
 */
async function handleResumeCommand(args: string[], context: CommandContext): Promise<void> {
  if (args.length === 0) {
    console.log(theme.error('[错误] 请提供要恢复的会话 ID，例如：/resume 171717171717'));
    return;
  }
  const id = args[0];
  const success = await context.session.loadState(id);
  if (success) {
    console.log(theme.success(`[系统] 成功恢复历史会话: ${id}`));
    // 清屏并打印已恢复的历史，重建终端心智模型
    redrawHistory(context.session);
  } else {
    console.log(theme.error(`[错误] 恢复失败，找不到该会话或记录文件已损坏: ${id}`));
  }
}

/**
 * 动态启停 MCP Server 连接状态。
 *
 * @param args 命令行附带的参数数组（预期格式: enable/disable <server_name>）
 * @param context 命令执行上下文
 */
async function handleMcpCommand(args: string[], context: CommandContext): Promise<void> {
  if (args.length < 1) {
    console.log(theme.error('[错误] 用法: /mcp <list|enable|disable> [server_name]'));
    return;
  }

  const action = args[0];
  const serverName = args[1];
  const mcpManager = context.session.mcpManager;

  if (!mcpManager) {
    console.log(theme.error('[错误] 当前系统尚未配置或初始化 MCP Tool Manager。'));
    return;
  }

  try {
    if (action === 'list') {
      const statuses = await mcpManager.getMcpServersStatus();
      if (statuses.length === 0) {
        console.log(theme.info('[系统] 当前未配置任何 MCP 服务。'));
        return;
      }
      console.log(`\n${theme.success('MCP 服务清单:')}`);
      for (const s of statuses) {
        const stateStr = s.enabled ? (s.connected ? theme.success('已连接') : theme.warning('启用但未连接')) : theme.dim('已停用');
        console.log(`  ${theme.highlight(s.name.padEnd(15))} [${stateStr}] - ${theme.dim(s.command)}`);
      }
      console.log();
    } else if (action === 'enable') {
      if (!serverName) return console.log(theme.error('[错误] 请指定服务名: /mcp enable <server_name>'));
      // 1. 回写文件状态
      updateMcpServerStatus(serverName, true);
      // 2. 动态连接挂载工具
      await mcpManager.connectServer(serverName);
      console.log(theme.success(`[系统] 成功启用并挂载 MCP 服务: ${serverName}`));
    } else if (action === 'disable') {
      if (!serverName) return console.log(theme.error('[错误] 请指定服务名: /mcp disable <server_name>'));
      // 1. 回写文件状态
      updateMcpServerStatus(serverName, false);
      // 2. 断开连接并清理路由元数据
      await mcpManager.disconnectServer(serverName);
      console.log(theme.success(`[系统] 成功断开并停用 MCP 服务: ${serverName}`));
    } else {
      console.log(theme.error('[错误] 未知的 MCP 操作，仅支持 enable 和 disable'));
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(theme.error(`[错误] 操作 MCP 服务时出错: ${msg}`));
  }
}

/**
 * 查阅当前系统可用工具清单
 */
async function handleToolCommand(args: string[], context: CommandContext): Promise<void> {
  if (!args[0] || args[0] === 'list') {
    const mcpManager = context.session.mcpManager;
    let tools: Array<{ function?: { name?: string; description?: string } }> = [];
    if (mcpManager) {
      tools = (await mcpManager.getMcpTools()) as Array<{ function?: { name?: string; description?: string } }>;
    }

    if (tools.length === 0) {
      console.log(theme.info('[系统] 当前没有挂载任何外部可用工具。'));
      return;
    }

    console.log(`\n${theme.success('可用扩展工具清单:')}`);
    for (const t of tools) {
      const name = t.function?.name || 'unknown';
      const desc = t.function?.description || '无描述';
      console.log(`  ${theme.highlight(name.padEnd(25))} - ${theme.dim(desc)}`);
    }
    console.log();
  } else {
    console.log(theme.error('[错误] 未知的 tool 操作，仅支持 /tool list'));
  }
}
