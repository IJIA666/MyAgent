import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { getEncoding } from 'js-tiktoken';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import { buildSystemPrompt } from './prompts.js';
import { LlmConfig } from '../config/types.js';

const encoder = getEncoding('cl100k_base');

/**
 * 计算文本的 Token 数量
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  return encoder.encode(text).length;
}

/**
 * 估算单个 Chat Message 的 Token 数量
 */
export function estimateMessageTokens(message: ChatCompletionMessageParam): number {
  let tokens = 4; // 消息框架基础开销
  if (typeof message.content === 'string') {
    tokens += countTokens(message.content);
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === 'text' && 'text' in part) {
        tokens += countTokens(part.text);
      }
    }
  }
  // 加上工具调用的 Token 消耗
  if (message.role === 'assistant') {
    const customMsg = message as {
      tool_calls?: Array<{
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    if (customMsg.tool_calls && Array.isArray(customMsg.tool_calls)) {
      for (const tc of customMsg.tool_calls) {
        if (tc.function) {
          tokens += countTokens(tc.function.name || '');
          tokens += countTokens(tc.function.arguments || '');
        }
      }
    }
  }
  return tokens;
}

/**
 * 计算字符串的 MD5 哈希
 */
export function computeStringHash(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

export interface ApiUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}

export interface ContextTokenUsage {
  total: number;
  system: number;
  rules: number;
  transient: number;
  history: number;
  isEstimated: boolean;
}

/**
 * 会话上下文管理类。
 * 核心职责：
 * 1. 维护当前会话的消息历史（Message History）。
 * 2. 管理会话唯一标识（Session ID）。
 * 3. 负责会话状态的文件系统持久化读写。
 */
export class SessionContext {
  private messageHistory: ChatCompletionMessageParam[] = [];
  private sessionId: string;
  private checkpointSummary: string | null = null;
  private recentFiles: string[] = [];

  private lastApiUsage: ApiUsage | null = null;
  private lastApiHistoryLength: number = 0;


  /**
   * 实例初始化。
   * @param sessionId 可选的会话标识，若不传则自动按当前时间戳生成。
   */
  constructor(sessionId?: string) {
    // 如果没有传入 sessionId，则使用当前时间戳作为默认会话标识
    this.sessionId = sessionId || Date.now().toString();

    // 初始化系统指令，确立智能体的工作边界与行为准则
    const systemPrompt = buildSystemPrompt();
    // 将系统提示词作为会话的第一条消息压入历史栈
    this.messageHistory.push({
      role: 'system',
      content: systemPrompt
    });
  }
  
  /**
   * 重新组装并更新会话消息历史中的首条系统提示词（System Prompt）。
   * 此方法保持消息历史中的第 0 个系统消息节点，直接覆写其 content，常用于规则热重载。
   *
   * @param customGlobalRules 可选的全局规则内容缓存，用于覆盖并锁定
   */
  public updateSystemPrompt(customGlobalRules?: string): void {
    const systemPrompt = buildSystemPrompt(customGlobalRules);
    if (this.messageHistory.length > 0 && this.messageHistory[0].role === 'system') {
      this.messageHistory[0].content = systemPrompt;
    }
  }

  /**
   * 获取当前会话唯一标识。
   *
   * @returns 当前会话的唯一 ID 字符串
   */
  public getSessionId(): string {
    return this.sessionId;
  }

  /**
   * 获取当前物理会话所关联的 Checkpoint 提炼摘要。
   *
   * @returns 提炼的摘要内容，若无则返回 null
   */
  public getCheckpointSummary(): string | null {
    return this.checkpointSummary;
  }

  /**
   * 设定当前物理会话所关联的 Checkpoint 提炼摘要。
   *
   * @param summary 提炼的摘要内容
   */
  public setCheckpointSummary(summary: string | null): void {
    this.checkpointSummary = summary;
  }

  /**
   * 获取最近读写的文件记忆列表。
   *
   * @returns 被剔除历史中最近访问的文件相对路径列表
   */
  public getRecentFiles(): string[] {
    return this.recentFiles;
  }

  /**
   * 设定最近读写的文件记忆列表。
   *
   * @param files 最近访问的文件相对路径列表
   */
  public setRecentFiles(files: string[]): void {
    this.recentFiles = files;
  }

  /**
   * 获取当前 System Prompt 的哈希值（用于缓存抖动监测）
   */
  public getSystemPromptHash(): string {
    if (this.messageHistory.length > 0 && this.messageHistory[0].role === 'system') {
      const content = this.messageHistory[0].content;
      return typeof content === 'string' ? computeStringHash(content) : '';
    }
    return '';
  }

  /**
   * 更新最近一次大模型的 API 结算 Usage
   */
  public updateLastApiUsage(usage: ApiUsage, historyLength: number): void {
    this.lastApiUsage = usage;
    this.lastApiHistoryLength = historyLength;
  }

  /**
   * 获取最近一次 API 的 Usage 基准值
   */
  public getLastApiUsage(): ApiUsage | null {
    return this.lastApiUsage;
  }

  /**
   * 基于“锚点基准 + 增量计算”来预测当前拼装后的完整上下文 Token
   * 
   * @param snapshotContext 组装完成的待发送消息数组
   * @returns 预测的各分块 Token 数量
   */
  public estimateSnapshotTokens(snapshotContext: ChatCompletionMessageParam[]): ContextTokenUsage {
    // 1. 计算 system prompt Token 数 (snapshotContext[0])
    let systemTokens = 0;
    if (snapshotContext.length > 0 && snapshotContext[0].role === 'system') {
      systemTokens = estimateMessageTokens(snapshotContext[0]);
    }

    // 2. 区分规则、临时技能和对话历史
    let rulesTokens = 0;
    let transientTokens = 0;
    let historyTokens = 0;

    const nonSystemMessages: ChatCompletionMessageParam[] = [];
    for (let i = 1; i < snapshotContext.length; i++) {
      const msg = snapshotContext[i];
      if (msg.role === 'system') {
        const content = typeof msg.content === 'string' ? msg.content : '';
        if (content.startsWith('<project_rules>')) {
          rulesTokens += estimateMessageTokens(msg);
        } else if (content.startsWith('<transient_skill>')) {
          transientTokens += estimateMessageTokens(msg);
        } else {
          historyTokens += estimateMessageTokens(msg);
        }
      } else {
        nonSystemMessages.push(msg);
      }
    }

    // 3. 应用增量算法计算对话历史
    if (this.lastApiUsage) {
      const anchorBase = this.lastApiUsage.input_tokens + this.lastApiUsage.output_tokens;
      let incrementalTokens = 0;
      
      const lastNonSystemCount = Math.max(0, this.lastApiHistoryLength - 1);
      
      if (nonSystemMessages.length > lastNonSystemCount) {
        const incrementalMessages = nonSystemMessages.slice(lastNonSystemCount);
        for (const msg of incrementalMessages) {
          incrementalTokens += estimateMessageTokens(msg);
        }
      }
      
      // 历史 Token = 锚点 Base - 当前 System Tokens + 增量 Tokens
      historyTokens += Math.max(0, anchorBase - systemTokens + incrementalTokens);
    } else {
      for (const msg of nonSystemMessages) {
        historyTokens += estimateMessageTokens(msg);
      }
    }

    const total = systemTokens + rulesTokens + transientTokens + historyTokens + 3; // 3为结尾控制字符

    return {
      total,
      system: systemTokens,
      rules: rulesTokens,
      transient: transientTokens,
      history: historyTokens,
      isEstimated: true
    };
  }


  /**
   * 输出当前关联的上下文状态数据（不含深拷贝保护机制）。
   *
   * @returns 包含所有历史消息的数组
   */
  public getHistory(): ChatCompletionMessageParam[] {
    return this.messageHistory;
  }

  /**
   * 增加一条上下文消息
   *
   * @param message 待追加的标准模型消息载体对象
   */
  public addMessage(message: ChatCompletionMessageParam): void {
    // 将新消息追加到历史记录末尾
    this.messageHistory.push(message);
  }

  /**
   * 弹出一条上下文消息
   *
   * @returns 从队尾弹出的最新一条消息，若历史为空则返回 undefined
   */
  public popMessage(): ChatCompletionMessageParam | undefined {
    // 从历史记录末尾移除并返回该消息
    return this.messageHistory.pop();
  }

  /**
   * 将当前上下文静默序列化落盘到工作区文件
   */
  public async saveState(): Promise<void> {
    try {
      // 确定会话文件的存储目录
      const dir = path.join(process.cwd(), '.myagent/sessions');
      // 递归创建存储目录，确保路径存在
      await fs.mkdir(dir, { recursive: true });
      // 根据 sessionId 构造具体的文件路径
      const file = path.join(dir, `${this.sessionId}.json`);
      // 包装数据，不再保存 activeSkills（强制挂载属于单次会话临时状态）
      const stateToSave = {
        messages: this.messageHistory,
        checkpointSummary: this.checkpointSummary,
        recentFiles: this.recentFiles
      };
      // 将历史快照格式化为 JSON 字符串并写入文件（指定 UTF-8 编码）
      await fs.writeFile(file, JSON.stringify(stateToSave, null, 2), 'utf-8');
    } catch {
      // 捕获并吞掉异常，静默落盘失败不应阻断核心流程
    }
  }

  /**
   * 恢复指定的会话持久化数据覆盖当前内存上下文
   *
   * @param targetSessionId 需要恢复加载的目标会话标识符
   * @returns 布尔值。如果成功读取文件并解析恢复返回 true，文件不存在或解析失败返回 false
   */
  public async loadState(targetSessionId: string): Promise<boolean> {
    try {
      // 构造目标会话状态的文件路径
      const file = path.join(process.cwd(), '.myagent/sessions', `${targetSessionId}.json`);
      // 读取文件内容为文本数据
      const data = await fs.readFile(file, 'utf-8');
      // 将文本数据解析为 JSON 对象
      const parsed = JSON.parse(data);
      // 如果解析出的是数组格式，则认为是旧版本合法的历史记录
      if (Array.isArray(parsed)) {
        this.messageHistory = parsed;
        this.sessionId = targetSessionId;
        return true;
      } else if (parsed && Array.isArray(parsed.messages)) {
        // 新版本读取，恢复状态
        this.messageHistory = parsed.messages;
        this.sessionId = targetSessionId;
        this.checkpointSummary = parsed.checkpointSummary || null;
        this.recentFiles = parsed.recentFiles || [];
        return true;
      }
    } catch {
      // 忽略文件不存在或解析失败的异常，恢复失败时不抛出
    }
    // 恢复失败，返回 false
    return false;
  }

  /**
   * 基于激活模型的连接配置及其关联的最大上下文窗口，计算触发压缩的 Token 阈值（默认 75%）。
   *
   * @param config 激活的模型连接配置或激活的模型名称
   * @param ratio 触发压缩的水位线比例，默认 0.75
   * @returns 触发压缩的 Token 数量阈值
   */
  public getCompactionThreshold(config: LlmConfig | string, ratio: number = 0.75): number {
    let contextWindow = 32000; // 缺省保守值

    if (config && typeof config === 'object') {
      if (typeof config.contextWindow === 'number') {
        contextWindow = config.contextWindow;
      } else if (config.profile && typeof config.profile.contextWindow === 'number') {
        contextWindow = config.profile.contextWindow;
      }
    }

    return Math.floor(contextWindow * ratio);
  }
}
