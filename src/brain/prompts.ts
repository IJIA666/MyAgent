/**
 * 集中管理大语言模型的核心人设与指令预设（System Prompt）。
 * 剥离业务层中的硬编码字符串，并提供统一的组装接口，为未来扩展动态上下文预留骨架。
 */

// 预设的人设和最底层的不可撼动之规则
const BASE_SYSTEM_PROMPT = `你是一个专业且精确的本地智能体助手。
你严格在授权的工作区根目录下运行。
你可以使用提供给你的本地工具读取文件、写入文件以及列出目录内容。

**极其重要的指令：**
1. 所有文件操作都必须严格限制在授权的工作区目录下。你的工具集会自动执行此项校验，一旦你尝试越权操作外部目录，工具将返回拒绝访问的错误。
2. 如果工具在运行过程中返回错误（例如文件未找到、路径越权等），请分析错误原因并优雅地向用户解释，或者在修正参数后重新尝试调用。
3. 请直接、专业且精准地回答用户问题，避免冗余的客套话或占位信息。
4. 【语言强制】你必须始终使用简体中文进行思考（内部逻辑和推理链）以及最终回复，仅在必要时保留英文的专业术语或代码片段。`;

import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import { loadGlobalRules, loadSkills } from './contextLoader.js';

/**
 * 组装并获取最终的系统级人设文本。
 * 此方法允许接收外部已加载的全局规则缓存，以维持会话锁定的 Byte-stable 哈希前缀。
 * 注意：项目局部规则已剥离，改为在 ContextAdapter 中动态注入至 user 消息前，以防破坏前置缓存。
 * 
 * @param customGlobalRules 可选的全局规则内容缓存，若不传则从磁盘加载最新的规则状态
 * @returns {string} 完整的、准备用于发送给 LLM 的全局静态基线系统提示词字符串。
 */
export function buildSystemPrompt(customGlobalRules?: string): string {
  // 使用数组收集所有区块片段
  const parts: string[] = [BASE_SYSTEM_PROMPT];

  // 1. 挂载全局级规则
  const globalRules = customGlobalRules !== undefined ? customGlobalRules : loadGlobalRules();
  if (globalRules) {
    parts.push(`\n<global_rules>\n${globalRules}\n</global_rules>`);
  }

  // 2. 挂载全局技能目录大纲 (防范管中窥豹，保留全知视野)
  const allSkills = loadSkills();
  if (allSkills.length > 0) {
    // 提取所有技能名称和摘要供 LLM 建立全局感知
    const indexLines = allSkills.map(s => `- ${s.name}: ${s.description}`);
    parts.push(`\n<available_skills>\n${indexLines.join('\n')}\n</available_skills>`);
  }

  // 将所有片段拼装为一个长字符串
  return parts.join('\n');
}

/**
 * 组装大模型上下文压缩摘要的提炼提示词，返回供 LlmDriver 直接调用的 messages 数组。
 * 
 * @param messagesToCompact 需要被压缩提炼的历史消息数组
 * @returns 组装好的、用于调用总结模型的 messages 数组
 */
export function buildCompactionSummaryPrompt(
  messagesToCompact: ChatCompletionMessageParam[]
): ChatCompletionMessageParam[] {
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
   - 使用简体中文编写。`;

  // 将待压缩的消息历史格式化为易读的文本格式
  const formattedHistory = messagesToCompact.map((msg) => {
    let contentStr = '';
    if (typeof msg.content === 'string') {
      contentStr = msg.content;
    } else if (Array.isArray(msg.content)) {
      contentStr = msg.content
        .map((part: { type: string; text?: string }) => (part.type === 'text' && part.text ? part.text : ''))
        .join('\n');
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
