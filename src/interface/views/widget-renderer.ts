/**
 * 界面层无状态视图渲染器。
 * 核心职责：
 * 1. 负责控制台的历史记录重绘，提供对消息类型的格式化回显；
 * 2. 匹配并解析 project_rules 与 transient_skill 标签，渲染折叠卡片微件；
 * 3. 渲染 Token 预测预算和实际结算花费的监控面板。
 */

import type { ChatMessage } from '../../brain/ports/LlmPort.js';
import type { ApiUsage, ContextTokenUsage } from '../../brain/ports/TokenEstimatorPort.js';
import { theme } from '../../utils/theme.js';

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
  console.log(theme.dim('--- 时间旅行完成，当前剩余的有效记忆 ---'));

  for (const msg of history) {
    if (msg.role === 'system') continue;

    if (msg.role === 'user') {
      let contentStr = '';
      if (typeof msg.content === 'string') {
        contentStr = msg.content;
      }
      console.log(`\n${theme.info(`用户 [${modelName}] > `)}${renderContentWithWidgets(contentStr)}`);
    } else if (msg.role === 'assistant') {
      // 强转是为了兼容提取本地存储时的隐藏属性（例如 DeepSeek 特有的 reasoning_content）
      const customMsg = msg as unknown as { reasoning_content?: string };
      if (customMsg.reasoning_content) {
        console.log(`\n${theme.dim('[思考过程]')}\n${theme.dim(customMsg.reasoning_content)}`);
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
 */
export function renderTokenPanel(
  lastEstimated: ContextTokenUsage | null,
  lastUsage: ApiUsage | null,
  systemPromptHash: string | null
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

  const contextWindow = 64000;
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

  console.log(theme.divider('======================= 📊 TOKEN 监控面板 ======================='));
  console.log(`${theme.highlight('💡 预测 Token 预算：')}${totalEstimated}`);
  console.log(`   ├── 基础人设 (System):  ${systemTokens} (${pctSystem}%)`);
  console.log(`   ├── 规则集   (Rules):   ${rulesTokens} (${pctRules}%)`);
  console.log(`   ├── 临时技能 (Skill):   ${skillTokens} (${pctSkill}%)`);
  console.log(`   └── 历史对话 (History): ${historyTokens} (${pctHistory}%)`);
  console.log(theme.dim('--------------------------------------------------------------'));
  console.log(`${theme.highlight('⚡ API 实际结算 (Usage)：')}`);
  console.log(`   ├── 输入 Token (Input):  ${actualInput}`);
  console.log(`   ├── 输出 Token (Output): ${actualOutput}`);
  console.log(`   ├── 缓存命中 (Cached):   ${cachedTokens} (${hitRate}%)`);
  console.log(`   ├── 窗口占用 (Window):   ${totalActual} / ${contextWindow} (${windowRatio}%)`);
  console.log(`   └── 本轮估算花费 (Cost):  ${theme.success(costStr)}`);
  console.log(theme.dim('--------------------------------------------------------------'));
  console.log(`${theme.highlight('🔒 缓存一致性哈希 (Cache Hash)：')}${hashShort}`);
  console.log(theme.divider('================================================================'));
  console.log();
}
