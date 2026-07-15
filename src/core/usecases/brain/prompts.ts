/**
 * @fileoverview 集中管理大语言模型的核心人设与指令预设（System Prompt）。
 * 剥离业务层中的硬编码字符串，并提供统一的组装接口，为未来扩展动态上下文预留骨架。
 */

import type { ChatMessage } from '../../../ports/driven/llm/LlmPort.js';
import type { SkillMetadata } from './contextLoader.js';

/** 工具失败后的诊断、调整与结果真实性约束。 */
export const RULE_TOOL_RESULT_HANDLING = `工具调用失败时，先阅读错误并检查假设，再进行针对性修正；不要盲目重复相同调用，也不要声称未实际获得的结果。`;

/** 系统规则数组，按装配顺序排列。 */
export const SYSTEM_RULES = [
  RULE_TOOL_RESULT_HANDLING,
];

/** 默认的通用智能体身份与协作方式。 */
const BASE_SYSTEM_PROMPT_PREFIX = `你是 MyAgent，一个自主的通用智能助手。根据用户请求完成任务，并在需要时使用当前可用工具。清晰沟通，存在不确定性时明确说明；除非用户另有要求，重视实际帮助而非冗长表达。探索和调查应有针对性并保持高效。`;

/** 按系统规则顺序装配的稳定基础提示词。 */
export const BASE_SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT_PREFIX}\n` +
  SYSTEM_RULES.map((rule, i) => `${i + 1}. ${rule}`).join('\n');

/** 系统提示词的动态装配选项。 */
export interface SystemPromptOptions {
  /** 当前工具执行使用的工作目录，默认采用进程 CWD */
  workingDirectory?: string;
  /** 用户可见回复的偏好语言；未配置时不生成语言章节 */
  language?: string;
}

/** 转义动态文本中的 XML 保留字符，避免破坏提示词标签结构。 */
function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 根据显式语言偏好生成独立章节；未配置时不产生任何语言约束。 */
function buildLanguageSection(languagePreference?: string): string | null {
  const language = languagePreference?.trim();
  if (!language) return null;

  const escapedLanguage = escapeXmlText(language);
  return `<language>
Always respond in ${escapedLanguage}. Use ${escapedLanguage} for all explanations, comments, and communications with the user. Technical terms and code identifiers should remain in their original form.
</language>`;
}

/**
 * 组装并获取最终的系统级人设文本。
 * 使用 XML 标签在单 System 消息内构建三层物理与语义隔离架构：
 * 1. stable: 核心稳定人设与指令红线
 * 2. context: 工作区级的规则配置与技能大纲（相对稳定，仅在工作区改变或技能更新时失效）
 * 3. volatile: 高频变动的动态瞬时参数（不予缓存，置于尾部作为牺牲层）
 * 
 * @param customGlobalRules - 可选的已缓存全局规则内容
 * @param customLocalRules - 可选的已缓存局部规则内容
 * @param skills - 可选的技能元数据列表
 * @param options - 可选的动态系统提示词装配参数
 * @returns 组装好的符合三层 XML 结构且缓存友好的单个系统提示词字符串
 */
export function buildSystemPrompt(
  customGlobalRules?: string,
  customLocalRules?: string,
  skills?: SkillMetadata[],
  options: SystemPromptOptions = {}
): string {
  const parts: string[] = [];
  const workingDirectory = options.workingDirectory ?? process.cwd();

  // 1. stable（稳定人设层）
  parts.push(`<!-- 1. stable (稳定人设层) -->\n${BASE_SYSTEM_PROMPT}`);

  // 2. context (上下文环境层，工作区级稳定)
  const globalRules = customGlobalRules ?? '';
  const localRules = customLocalRules ?? '';
  const indexLines = skills && skills.length > 0
    ? skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')
    : '';

  parts.push(`\n<!-- 2. context (上下文环境层，工作区级稳定) -->\n<context_rules>`);
  if (indexLines) {
    parts.push(`  <available_skills>\n${indexLines.split('\n').map((line: string) => `    ${line}`).join('\n')}\n  </available_skills>`);
  }
  if (globalRules || localRules) {
    const combinedRules = [globalRules, localRules].filter(Boolean).join('\n\n');
    parts.push(`  <local_rules>\n${combinedRules.split('\n').map((line: string) => `    ${line}`).join('\n')}\n  </local_rules>`);
  }
  parts.push(`</context_rules>`);
  const languageSection = buildLanguageSection(options.language);
  if (languageSection) {
    parts.push(languageSection);
  }

  // 3. volatile（当前运行环境事实，不进入稳定前缀）
  const osStr = process.platform === 'win32' ? 'Windows' : process.platform;

  parts.push(`\n<!-- 3. volatile (当前运行环境事实) -->\n<volatile_context>
  <os>${osStr}</os>
  <cwd>${escapeXmlText(workingDirectory)}</cwd>
</volatile_context>`);

  return parts.join('\n');
}

/**
 * 组装大模型上下文压缩摘要的提炼提示词，返回供 LlmDriver 直接调用的 messages 数组。
 * 
 * @param messagesToCompact - 需要被压缩提炼的历史消息数组
 * @returns 组装好的、用于调用总结模型的 messages 数组
 */
export function buildCompactionSummaryPrompt(
  messagesToCompact: ChatMessage[]
): ChatMessage[] {
  const systemInstruction = `你是一个专业的上下文提炼助手。
你的任务是将待归档的智能体与用户的交互历史提炼为一份不超过 1000 字符的 Markdown 格式的概要（Checkpoint Summary）。

**请务必遵守以下提炼规则：**
1. **核心保留项**：
   - 已经达成的核心技术与设计决策。
   - 已经修改或创建的文件列表，以及对其所做修改的极简说明。
   - 当前面临的核心技术瓶颈、未决问题，以及明确的下一步任务（TODO 列表）。
2. **噪声过滤规则**：
   - 必须滤除工具执行时的海量冗余日志、大段的文件内容。
   - 必须过滤排查过程中的无用死胡同、反复失败的中间尝试。
   - 忽略多余的礼貌性寒暄或重复确认。
3. **输出格式约束**：
   - 直接输出 Markdown 文本，不要有任何包裹容器、前言或总结性客套话。
   - 保持语言简练，严格控制在 1000 字符以内。
   - 使用简体中文编写。

${IDENTIFIER_PRESERVATION_INSTRUCTION}`;

  // 将待压缩的消息历史格式化为易读的文本格式
  const formattedHistory = messagesToCompact.map((msg) => {
    let contentStr = '';
    if (typeof msg.content === 'string') {
      contentStr = msg.content;
    }
    // 包含工具调用情况
    let toolCallsStr = '';
    const customMsg = msg as {
      tool_calls?: Array<{
        function: {
          name: string;
        };
      }>;
    };
    if (msg.role === 'assistant' && customMsg.tool_calls && Array.isArray(customMsg.tool_calls)) {
      toolCallsStr = `\n[工具调用：${customMsg.tool_calls.map(tc => tc.function.name).join(', ')}]`;
    }
    return `[角色: ${msg.role}]${toolCallsStr}\n内容:\n${contentStr}\n---`;
  }).join('\n\n');

  return [
    {
      role: 'system',
      content: systemInstruction
    },
    {
      role: 'user',
      content: `以下是需要你提炼的交互历史：\n\n${formattedHistory}`
    }
  ];
}

export const IDENTIFIER_PRESERVATION_INSTRUCTION = `【严格标识符保护协议】
绝不允许缩写、省略或重构任何长相怪异 of UUID、Hash、IP地址、端口号、URL 以及绝对文件路径！
必须在摘要中原封不动地完整保留这些“不透明标识符”，违者将导致后续系统调用断链崩溃。`;

export const HANDOFF_INSTRUCTION = `【最高指挥官（LEADER）交接声明】
你正在接手一份从历史截断恢复的新会话。
你是整个系统的最高指挥官（LEADER），之前的具体执行工作是由你的子单元（SUBORDINATE）完成的。
请根据当前的上下文状态继续指挥，切勿重复子单元已经完成的底层体力代码编写工作，你只需给出战略级指令。`;

/**
 * 本地原生函数生成的确定性兜底摘要（防死锁变砖）。
 * 当异步总结连续失败、且即将爆仓时，强行构造此静态文本截断历史。
 *
 * @param lastToolName - 最近一次系统调用的核心工具名称
 * @param lastUserPrompt - 最近一次用户下发的原始指令
 * @returns 格式化后的静态兜底摘要文本
 */
export function buildStaticFallbackSummary(
  lastToolName: string | undefined,
  lastUserPrompt: string | undefined
): string {
  return `[系统强制截断警告：因辅助模型状态异常，历史上下文已被安全模块静态接管]
最近一次系统调用的核心工具：${lastToolName || '无'}
最近一次用户下发的指令：${lastUserPrompt || '无'}
请依据上述残存信息继续响应。`;
}
