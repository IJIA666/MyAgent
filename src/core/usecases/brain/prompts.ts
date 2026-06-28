/**
 * @fileoverview 集中管理大语言模型的核心人设与指令预设（System Prompt）。
 * 剥离业务层中的硬编码字符串，并提供统一的组装接口，为未来扩展动态上下文预留骨架。
 */

import type { ChatMessage } from '../../../ports/driven/llm/LlmPort.js';
import type { SkillMetadata } from './contextLoader.js';

// 预设的人设和最底层的不可撼动之规则
const BASE_SYSTEM_PROMPT = `你是一个专业且精确的本地智能体助手。
你严格在授权的工作区根目录下运行。
你可以使用提供给你的本地工具读取文件、写入文件以及列出目录内容。

**极其重要的核心工程红线指令 (MUST OBEY)：**
1. 所有文件操作都必须严格限制在授权的工作区目录下。你的工具集会自动执行此项校验，一旦你尝试越权操作外部目录，工具将返回拒绝访问的错误。
2. 如果工具在运行过程中返回错误（例如文件未找到、路径越权等），请分析错误原因并优雅地向用户解释，或者在修正参数后重新尝试调用。
3. 请直接、专业且精准地回答用户问题，避免冗余的客套话、假设性警告或占位信息。
4. 【语言强制】你必须始终使用简体中文进行思考（内部逻辑和推理链）以及最终回复，仅在必要时保留英文的专业术语或代码片段。
5. 【终端命令安全性约束】
{{OS_SECURITY_INSTRUCTIONS}}
6. 【最小重构与零注释污染原则】
   - 最小重构：仅针对请求的范围进行修改，绝对禁止顺便清理周围代码、增加未请求的 feature 或设计过度抽象。
   - 零注释污染：修改代码时必须在 API 声明正上方编写严格的 JSDoc/TSDoc 注释（ JSDoc/TSDoc 必须移除 {type} 声明，参数用 @param name - 描述 语法，返回值描述采用 @returns 描述 语法），非必要不乱加注释，严禁对未修改的代码乱加或改动 JSDoc。
7. 【专用工具优先】
   - 凡是可用原生工具（如文件读写 read_file/write_to_file、目录查询 list_dir、ripgrep 检索 grep_search 等）完成的操作，绝对禁止调用通用的终端 Shell 工具（ExecuteCommandTool）执行 cat, sed, awk, find, grep 等文件操作。终端命令仅用于编译、跑测试等确实无法由原生工具覆盖的系统管理。
8. 【长期记忆参考指令】在对话过程中，您必须参考最新 User 消息中注入的 <long-term-memory> 长期记忆事实。`;

/**
 * 针对不同操作系统的特定命令约束与安全性要求映射。
 * 显式导出以允许白盒测试直接对其各分支文本进行内容校验，免去 mock 环境变量的复杂性。
 */
export const OS_INSTRUCTIONS_MAP: Record<string, string> = {
  win32: `你当前运行的宿主操作系统是 Windows。当你需要使用 execute_command 工具执行命令时：
   - 必须且仅能执行单一、原子的 Windows 原生命令（例如使用 'tasklist' 替代 'top/ps'，使用 'ipconfig' 替代 'ifconfig'）。
   - 绝对禁止使用任何复合连接符、重定向符、分号、换行或管道符（如 &, &&, |, ||, ;, <, >, \\n 等）将多个独立操作拼接为单条长命令，否则将被沙箱引擎强制拦截执行。`,
  darwin: `你当前运行的宿主操作系统是 macOS (Darwin)。当你需要使用 execute_command 工具执行命令时：
   - 必须且仅能执行单一、原子的 POSIX 命令。
   - 绝对禁止使用任何复合连接符、重定向符、分号、换行或管道符将多个独立操作拼接为单条长命令，否则将被拦截。`,
  linux: `你当前运行的宿主操作系统是 Linux。当你需要使用 execute_command 工具执行命令时：
   - 必须且仅能执行单一、原子的 POSIX/Linux 命令。
   - absolute 绝对禁止使用任何复合连接符、重定向符、分号、换行或管道符将多个独立操作拼接为单条长命令，否则将被拦截。`
};

// 在模块加载初始化时，一次性自适应替换占位符并固化为 RESOLVED_BASE_PROMPT，满足全局 stable 层的绝对静态性。
const osPlatform = process.platform;
const osInstruction = OS_INSTRUCTIONS_MAP[osPlatform] ?? OS_INSTRUCTIONS_MAP.linux;
export const RESOLVED_BASE_PROMPT = BASE_SYSTEM_PROMPT.replace('{{OS_SECURITY_INSTRUCTIONS}}', osInstruction);

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
 * @returns 组装好的符合三层 XML 结构且缓存友好的单个系统提示词字符串
 */
export function buildSystemPrompt(
  customGlobalRules?: string,
  customLocalRules?: string,
  skills?: SkillMetadata[]
): string {
  const parts: string[] = [];

  // 1. stable (稳定人设层，绝对静态，100% 缓存命中)
  parts.push(`<!-- 1. stable (稳定人设层，绝对静态，100% 缓存命中) -->\n${RESOLVED_BASE_PROMPT}`);

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

  // 3. volatile (易变数据层，高频变动，不予缓存)
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
  const cwdStr = process.cwd();
  const osStr = process.platform === 'win32' ? 'Windows' : process.platform;
  
  parts.push(`\n<!-- 3. volatile (易变数据层流通，高频变动，不予缓存) -->\n<volatile_context>
  <date>${dateStr}</date>
  <cwd>${cwdStr}</cwd>
  <os>${osStr}</os>
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
