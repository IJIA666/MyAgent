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
