/**
 * 界面层无状态视图渲染器。
 * 核心职责：
 * 1. 负责控制台的历史记录重绘，提供对消息类型的格式化回显；
 * 2. 匹配并解析 project_rules 与 transient_skill 标签，渲染折叠卡片微件；
 * 3. 渲染 Token 预测预算和实际结算花费的监控面板。
 */

import type { ChatMessage } from '../../../../ports/driven/llm/LlmPort.js';
import type { ApiUsage, ContextTokenUsage } from '../../../../ports/driven/llm/TokenEstimatorPort.js';
import { theme } from './theme.js';
import { getUserPermissionModeLabel } from '../../../../core/domain/permissions/permission-types.js';

const DEFAULT_RENDER_WIDTH = 88;
const MIN_RENDER_WIDTH = 56;
const MAX_RENDER_WIDTH = 104;

/** 获取适合当前终端的安全渲染宽度。 */
function getRenderWidth(): number {
  const columns = process.stdout.columns || DEFAULT_RENDER_WIDTH;
  return Math.max(MIN_RENDER_WIDTH, Math.min(MAX_RENDER_WIDTH, columns));
}

/** 截断过长文本，防止状态行撑破终端布局。 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

/** 创建固定宽度的终端横线。 */
function rule(char: string, width = getRenderWidth()): string {
  return char.repeat(Math.max(1, width));
}

/** 创建固定宽度的边框内容行。 */
function frameLine(content: string, width = getRenderWidth()): string {
  const innerWidth = Math.max(1, width - 4);
  return `│ ${truncateText(content, innerWidth).padEnd(innerWidth)} │`;
}

/** 创建简洁的单行比例条。 */
function usageBar(value: number, total: number, width = 22): string {
  if (total <= 0) {
    return `[${'-'.repeat(width)}]`;
  }
  const filled = Math.max(0, Math.min(width, Math.round((value / total) * width)));
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}]`;
}

/** 将 JSON 对象压缩为适合终端单行展示的文本。 */
function compactJson(value: unknown): string {
  try {
    return truncateText(JSON.stringify(value), 240);
  } catch {
    return '[无法序列化参数]';
  }
}

/**
 * 渲染 CLI 启动页头。
 *
 * @param modelName - 当前激活模型名称
 * @param permissionMode - 当前权限模式
 * @param sessionId - 当前会话 ID
 */
export function renderSessionHeader(modelName: string, permissionMode: string, sessionId: string): void {
  const width = getRenderWidth();
  const shortSessionId = truncateText(sessionId, 20);
  console.log(theme.brand(`┌${rule('─', width - 2)}┐`));
  console.log(theme.brand(frameLine('MyAgent CLI', width)));
  console.log(theme.info(frameLine(`model: ${truncateText(modelName, 28)}  mode: ${getUserPermissionModeLabel(permissionMode)}  session: ${shortSessionId}`, width)));
  console.log(theme.brand(`└${rule('─', width - 2)}┘`));
  console.log(theme.dim('输入 / 打开命令菜单，输入 exit 或 quit 结束会话。双击 Esc 可中断或回滚。'));
  console.log();
}

/**
 * 构建动态输入提示符。
 *
 * @param modelName - 当前激活模型名称
 * @param permissionMode - 当前权限模式
 * @returns 可直接传给 readline 的提示符文本
 */
export function renderPromptPrefix(modelName: string, permissionMode: string): string {
  return `${theme.brand('myagent')} ${theme.dim(`[${modelName} | ${getUserPermissionModeLabel(permissionMode)}]`)} ${theme.highlight('›')} `;
}

/**
 * 渲染流式区块标题。
 *
 * @param title - 区块标题
 * @param detail - 可选补充说明
 * @returns 带换行的标题文本
 */
export function renderSectionTitle(title: string, detail?: string): string {
  const suffix = detail ? ` ${detail}` : '';
  return `\n${theme.divider(`┄ [${title}]${suffix} ${rule('┄', 12)}`)}\n`;
}

/**
 * 渲染工具调用开始卡片。
 *
 * @param functionName - 工具名称
 * @param functionArgs - 工具调用参数
 * @returns 工具调用开始提示文本
 */
export function renderToolCallStart(functionName: string, functionArgs: unknown): string {
  const args = compactJson(functionArgs);
  return [
    '',
    theme.info(`[⚡ 正在调用工具 "${functionName}"]`),
    theme.dim(`┌─ 调度参数`),
    `│ ${theme.highlight(args)}`,
    theme.dim(`└─ 等待工具返回`)
  ].join('\n');
}

/**
 * 渲染工具调用完成反馈。
 *
 * @param functionName - 工具名称
 * @param result - 工具返回文本
 * @param status - 工具调用成功或失败的显式状态
 * @returns 工具调用完成提示文本
 */
export function renderToolCallResult(
  functionName: string,
  result: string,
  status: 'success' | 'error',
): string {
  if (status === 'error') {
    return theme.warning(
      `[反馈] 工具 "${functionName}" 调用失败，错误结果已返回给 Agent。`,
    );
  }
  return theme.dim(`[反馈] 工具 "${functionName}" 执行完毕，返回了 ${result.length} 字节的数据。`);
}

/**
 * 渲染本轮响应完成提示。
 *
 * @returns 完成提示文本
 */
export function renderCompletionBanner(): string {
  return `\n\n${theme.divider('系统响应 >')} ${theme.success('完毕。')}\n`;
}

/**
 * 渲染后台 Skill 复盘结果的非阻塞状态行。
 * 该事件只告知用户后台已完成 Skill 变更，不参与渲染状态机
 * （complete 仍是本轮唯一终结点），也不会写回模型历史。
 *
 * @param status - 真实写入结果状态（success/staged）
 * @param action - Skill 管理动作
 * @param skill - 被变更的 Skill 名称
 * @param pendingId - 可选暂存标识
 * @returns 弱化样式的一行状态文本
 */
export function renderSkillReviewUpdate(
  status: 'success' | 'staged',
  action: string,
  skill: string,
  pendingId?: string,
): string {
  const outcome = status === 'staged' ? '已暂存，等待批准' : '已完成';
  const pending = pendingId ? `（暂存 ${pendingId}）` : '';
  return theme.dim(`[后台技能] ${action}「${skill}」${outcome}${pending}`);
}

/**
 * 将消息内容中内含的 XML 标签和定界符，解析并折叠转换为具有终端视觉效果的精美标签卡片微件。
 * @param content 原始的文本消息内容
 * @returns 过滤并折叠渲染后的文本
 */
export function renderContentWithWidgets(content: string): string {
  if (!content) return content;

  let cleanText = content;
  const widgets: string[] = [];

  // 1. 匹配并解析 project_rules
  const rulesRegex = /<project_rules>([\s\S]*?)<\/project_rules>/g;
  let rulesMatch;
  while ((rulesMatch = rulesRegex.exec(content)) !== null) {
    const len = rulesMatch[1].length;
    widgets.push(`  ${theme.dim('↙')} ${theme.highlight('rules: project_rules')} ${theme.dim(`(${len} 字符 - 已自动折叠锁定缓存)`)}`);
  }
  cleanText = cleanText.replace(rulesRegex, '');

  // 2. 匹配并解析 transient_skill
  const skillRegex = /<transient_skill>([\s\S]*?)<\/transient_skill>/g;
  let skillMatch;
  while ((skillMatch = skillRegex.exec(content)) !== null) {
    const len = skillMatch[1].length;
    widgets.push(`  ${theme.dim('↙')} ${theme.highlight('skill: transient_skill')} ${theme.dim(`(${len} 字符 - 已自动折叠锁定缓存)`)}`);
  }
  cleanText = cleanText.replace(skillRegex, '');

  // 3. 过滤系统声明前置与后置定界语
  cleanText = cleanText
    .replace(/\[SYSTEM NOTE:[\s\S]*?\]\n?/g, '')
    .replace(/\n?\[END OF SYSTEM NOTE\]/g, '')
    .trim();

  if (widgets.length > 0) {
    return `${cleanText}\n\n${widgets.join('\n')}`;
  }

  return cleanText;
}

/**
 * 清屏并重新渲染当前生效的会话上下文。
 * 通过传入纯净的历史数据和模型名称实现无状态渲染，便于单元测试。
 * @param history 当前对话的消息参数历史数组
 * @param modelName 当前激活的大语言模型名称
 */
export function redrawHistory(history: ChatMessage[], modelName: string): void {
  console.clear();
  const width = getRenderWidth();
  console.log(theme.brand(`┌${rule('─', width - 2)}┐`));
  console.log(theme.brand(frameLine('会话历史重绘', width)));
  console.log(theme.brand(`└${rule('─', width - 2)}┘`));
  console.log(theme.dim('--- 时间旅行完成，当前剩余的有效记忆 ---'));

  for (const msg of history) {
    if (msg.role === 'system') continue;

    if (msg.role === 'user') {
      let contentStr = '';
      if (typeof msg.content === 'string') {
        contentStr = msg.content;
      }
      console.log(`\n${theme.info(`用户 [${modelName}]`)} ${theme.highlight('›')} ${renderContentWithWidgets(contentStr)}`);
    } else if (msg.role === 'assistant') {
      // 强转是为了兼容提取本地存储时的隐藏属性（例如 DeepSeek 特有的 reasoning_content）
      const customMsg = msg as unknown as { reasoning_content?: string };
      if (customMsg.reasoning_content) {
        console.log(`${renderSectionTitle('思考过程')}${theme.dim(customMsg.reasoning_content)}`);
      }
      if (msg.content) {
        console.log(`\n${msg.content}`);
      }
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          console.log(`\n${theme.info(`[⚡ 工具调用记录: "${tc.function.name}"]`)}`);
        }
      }
    } else if (msg.role === 'tool') {
      console.log(theme.dim(`[反馈] 工具执行完毕。`));
    }
  }
  console.log(`\n${theme.divider('以上为当前状态 >')} 随时准备继续\n`);
}

/**
 * 在终端中渲染出可视化 Token 预算及 API 结算的监控面板。
 * @param lastEstimated 预测 Token 预算明细
 * @param lastUsage 实际结算 Usage 详情
 * @param systemPromptHash 当前 System Prompt 的 MD5 摘要哈希值
 * @param effectiveContextWindow 当前会话的有效上下文窗口（可选，缺失时显示未知状态）
 */
export function renderTokenPanel(
  lastEstimated: ContextTokenUsage | null,
  lastUsage: ApiUsage | null,
  systemPromptHash: string | null,
  effectiveContextWindow?: number
): void {
  if (!lastEstimated) return;

  const systemTokens = lastEstimated.system ?? 0;
  const rulesTokens = lastEstimated.rules ?? 0;
  const skillTokens = lastEstimated.transient ?? 0;
  const historyTokens = lastEstimated.history ?? 0;
  const totalEstimated = lastEstimated.total ?? 0;

  const pctSystem = totalEstimated > 0 ? ((systemTokens / totalEstimated) * 100).toFixed(1) : '0.0';
  const pctRules = totalEstimated > 0 ? ((rulesTokens / totalEstimated) * 100).toFixed(1) : '0.0';
  const pctSkill = totalEstimated > 0 ? ((skillTokens / totalEstimated) * 100).toFixed(1) : '0.0';
  const pctHistory = totalEstimated > 0 ? ((historyTokens / totalEstimated) * 100).toFixed(1) : '0.0';

  // 使用调用方传入的有效窗口，未知时显示明确的未知状态
  const contextWindow = effectiveContextWindow ?? 0;
  const totalActual = lastUsage ? (lastUsage.input_tokens + lastUsage.output_tokens) : totalEstimated;
  const windowRatio = ((totalActual / contextWindow) * 100).toFixed(1);

  let actualInput = '暂无数据';
  let actualOutput = '暂无数据';
  let cachedTokens = 0;
  let hitRate = '0.0';
  let costStr = '暂无数据';

  if (lastUsage) {
    actualInput = String(lastUsage.input_tokens);
    actualOutput = String(lastUsage.output_tokens);
    cachedTokens = lastUsage.prompt_tokens_details?.cached_tokens ?? 0;
    hitRate = lastUsage.input_tokens > 0 ? ((cachedTokens / lastUsage.input_tokens) * 100).toFixed(1) : '0.0';

    const inputCost = (lastUsage.input_tokens - cachedTokens) * 0.00014 / 1000 + cachedTokens * 0.000014 / 1000;
    const outputCost = lastUsage.output_tokens * 0.00028 / 1000;
    const totalCostUsd = inputCost + outputCost;
    const totalCostCny = totalCostUsd * 7.25;
    costStr = `$${totalCostUsd.toFixed(6)} (约 ￥${totalCostCny.toFixed(5)})`;
  }

  const hashShort = systemPromptHash ? systemPromptHash.slice(0, 8) : '暂无';

  const panelWidth = getRenderWidth();
  console.log(theme.divider(`┌${rule('─', panelWidth - 2)}┐`));
  console.log(theme.divider(frameLine('TOKEN 监控面板', panelWidth)));
  console.log(theme.divider(`└${rule('─', panelWidth - 2)}┘`));
  console.log(`${theme.highlight('预测 Token 预算：')}${totalEstimated} ${theme.dim(usageBar(totalEstimated, contextWindow))}`);
  console.log(`  ${theme.dim('System ')} ${String(systemTokens).padStart(7)} (${pctSystem.padStart(5)}%) ${usageBar(systemTokens, totalEstimated, 16)}`);
  console.log(`  ${theme.dim('Rules  ')} ${String(rulesTokens).padStart(7)} (${pctRules.padStart(5)}%) ${usageBar(rulesTokens, totalEstimated, 16)}`);
  console.log(`  ${theme.dim('Skill  ')} ${String(skillTokens).padStart(7)} (${pctSkill.padStart(5)}%) ${usageBar(skillTokens, totalEstimated, 16)}`);
  console.log(`  ${theme.dim('History')} ${String(historyTokens).padStart(7)} (${pctHistory.padStart(5)}%) ${usageBar(historyTokens, totalEstimated, 16)}`);
  console.log(theme.dim(rule('─', Math.min(70, getRenderWidth()))));
  console.log(`${theme.highlight('API 实际结算 (Usage)：')}`);
  console.log(`  Input  ${actualInput}`);
  console.log(`  Output ${actualOutput}`);
  console.log(`  Cached ${cachedTokens} (${hitRate}%)`);
  console.log(`  Window ${totalActual} / ${contextWindow} (${windowRatio}%) ${usageBar(totalActual, contextWindow, 16)}`);
  console.log(`  Cost   ${theme.success(costStr)}`);
  console.log(theme.dim(rule('─', Math.min(70, getRenderWidth()))));
  console.log(`${theme.highlight('缓存一致性哈希 (Cache Hash)：')}${hashShort}`);
  console.log(theme.divider(rule('═', Math.min(70, getRenderWidth()))));
  console.log();
}
