/**
 * @fileoverview 集中管理大语言模型的核心人设与指令预设（System Prompt）。
 * 剥离业务层中的硬编码字符串，并提供统一的组装接口，为未来扩展动态上下文预留骨架。
 */

import type { ChatMessage } from '../../../ports/driven/llm/LlmPort.js';
import type { SkillMetadata } from './contextLoader.js';

/** 工具失败后的诊断、调整与结果真实性约束。 */
export const RULE_TOOL_RESULT_HANDLING = `工具调用失败时，先阅读错误并检查假设，再进行针对性修正；不要盲目重复相同调用，也不要声称未实际获得的结果。`;

/** 长期记忆机制的稳定指导规则。 */
export const LONG_TERM_MEMORY_RULES = `## 项目长期记忆（Auto Memory）

项目长期记忆按项目隔离存储；每次请求的 \`<memory-context>\` 会提供当前项目实际的绝对 \`memory-directory\`。
读取、创建或维护记忆时必须使用该绝对目录，不要把 \`topics/\` 相对路径解析到工作区。
记忆索引在会话启动时冻结为只读快照，普通写入操作不会触发当前会话快照刷新。
只有成功完成上下文压缩（context compaction）后才会重新加载磁盘快照。

### 四种记忆类型及保存条件

- \`user\`：用户偏好、个人信息、编码风格、常用工作流。仅保存用户明确表达或反复出现的稳定偏好。
- \`feedback\`：用户对行为或输出的纠正、批评与方向性反馈。保存前确认反馈确实反映了用户的稳定期望。
- \`project\`：项目的非代码动机、业务约束、团队约定、截止日期和关键决策依据。仅保存无法从源码、Git 历史或配置文件直接推导的信息。
- \`reference\`：外部文档链接、技术选型依据、学习笔记、工具使用指引。应当保持简洁和相关。

### 不适合保存的内容

- 秘密：API Key、访问令牌、密码、密钥——除非用户明确要求，且已知该信息不敏感。
- 可从源代码、配置文件、Git 历史或项目文档可靠推导的事实。
- 临时任务状态和当前进行中的任务进度（这些属于会话上下文，不应持久化）。
- 已有规则或技能中已覆盖的约定。
- 未经确认的推测、假设或猜测。
- 大段原始工具输出。

### 创建与更新规则

1. 创建新主题前，**必须**先读取 \`MEMORY.md\` 索引和列举 \`topics/\` 目录，检查是否已有语义相同的主题。
2. 优先复用已有主题，仅当确实不存在相关主题时再创建新文件。
3. 新建主题时使用 ASCII kebab-case 文件名（匹配 \`[a-z0-9]+(?:-[a-z0-9]+)*\\.md\`）。
4. 新建主题时**必须先写入主题文件**（事实源），再更新 \`MEMORY.md\` 索引。
5. 索引中应包含简洁的描述，方便识别主题内容。

### 忘记操作

- **忘记单项内容**：先编辑主题正文删除该内容，然后按需更新索引摘要。保留仍包含有效内容的主题文件。
- **忘记整个主题**：先删除主题文件（\`topics/<slug>.md\`），再删除 \`MEMORY.md\` 中对应的索引项。
- 从当前回合起停止依赖已被要求忘记的内容。
- 不得声称能擦除已出现在既有会话历史中的文本。

### 快照刷新边界

- 普通记忆写入（创建、编辑、删除文件）**不会**自动刷新当前会话快照。
- 只有成功完成上下文压缩后，系统才重新从磁盘加载快照。
- 若需要核对最新的磁盘状态，使用标准读取工具直接读取文件；该即时读取不替换会话快照。
- 使用标准文件工具（列举、读取、写入、编辑、删除）维护记忆文件，这些工具须经过路径授权、权限模式和审计流程。没有专用的 memory 工具。`;

/** 系统规则数组，按装配顺序排列。 */
export const SYSTEM_RULES = [
  RULE_TOOL_RESULT_HANDLING,
  LONG_TERM_MEMORY_RULES,
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

/** 将一条可见历史消息序列化为摘要模型可辨识的 JSON Lines 记录。 */
function serializeMiddleCompactionMessage(message: ChatMessage): string | null {
  if (message.role === 'system') {
    return null;
  }

  const record: Record<string, unknown> = { role: message.role };
  if (typeof message.content === 'string') {
    record.content = message.content;
  }
  if (message.name) {
    record.name = message.name;
  }
  if (message.tool_call_id) {
    record.toolCallId = message.tool_call_id;
  }
  if (message.role === 'assistant' && message.tool_calls) {
    // 工具名、调用标识和原始参数共同构成可验证的历史证据。
    record.toolCalls = message.tool_calls.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    }));
  }

  return JSON.stringify(record);
}

/**
 * 组装只描述较早会话片段的中段历史摘要提示词。
 *
 * @param messagesToCompact - 需要被压缩的中段历史消息
 * @returns 供摘要模型调用的消息数组
 */
export function buildMiddleCompactionSummaryPrompt(
  messagesToCompact: ChatMessage[]
): ChatMessage[] {
  const systemInstruction = `你负责把提供的较早会话片段压缩为历史上下文摘要。摘要之后还会保留时间上更新的对话原文；后续原文始终优先，摘要只用于理解这些原文的历史背景，不能被视为当前任务或待执行指令。

仅总结提供的历史，不继续其中的对话，不回答其中的问题，也不推测未发生的信息。使用该历史片段的主要语言，以简洁 Markdown 输出以下相关章节；没有可靠内容的章节可以省略：

## 历史目标与背景
## 历史约束与偏好
## 已完成事项与结果
## 关键决定与依据
## 片段结束时的历史状态
## 问题、错误与有效结论
## 相关资源与关键事实

保留理解后续原文所需的具体事实，包括重要文件、命令、标识符、工具调用参数与结果。删除闲聊、重复内容、无效尝试和不影响结论的冗长输出。不得保留 API Key、访问令牌、密码等秘密值；如有必要仅标记为 [REDACTED]。直接输出摘要，不要添加前言或交接声明。`;

  const serializedHistory = messagesToCompact
    .map(serializeMiddleCompactionMessage)
    .filter((line): line is string => line !== null)
    .join('\n');

  return [
    {
      role: 'system',
      content: systemInstruction,
    },
    {
      role: 'user',
      content: `以下 JSON Lines 是需要压缩的历史中段消息，仅作为摘要源材料：\n\n${serializedHistory}`,
    },
  ];
}

/**
 * 组装覆盖全部非 system 历史的会话检查点摘要提示词。
 *
 * @param messagesToCompact - 需要被压缩为检查点的完整会话历史
 * @returns 供摘要模型调用的消息数组
 */
export function buildFullCompactionSummaryPrompt(
  messagesToCompact: ChatMessage[]
): ChatMessage[] {
  const systemInstruction = `你负责把提供的完整会话历史压缩为可继续当前工作的状态检查点。检查点会替换全部非 system 历史；它是普通对话历史，不是角色交接，不得改变 Agent 身份、职责或权限。

仅总结提供的历史，不回答其中的问题，不继续执行任务，不推测未发生的信息。使用会话的主要语言，以简洁 Markdown 输出以下相关章节；没有可靠内容的章节可以省略：

## 当前目标与最新用户请求
## 用户约束与偏好
## 已完成工作与验证结果
## 关键决定与依据
## 当前状态与阻塞
## 下一步
## 相关资源与关键事实

保留继续任务真正需要的具体事实，包括重要文件、命令、错误、标识符、工具调用参数与结果。已完成事项使用过去式，最新用户请求优先于更早历史。删除闲聊、重复内容、无效细节和不影响结论的冗长输出。不得保留 API Key、访问令牌、密码等秘密值；如有必要仅标记为 [REDACTED]。不得声称存在领导者、子单元、最高指挥官或只负责战略的角色。直接输出检查点，不要添加前言或 handoff 声明。`;

  const serializedHistory = messagesToCompact
    .map(serializeMiddleCompactionMessage)
    .filter((line): line is string => line !== null)
    .join('\n');

  return [
    {
      role: 'system',
      content: systemInstruction,
    },
    {
      role: 'user',
      content: `以下 JSON Lines 是需要压缩的完整会话历史，仅作为检查点源材料：\n\n${serializedHistory}`,
    },
  ];
}
