import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import { buildSystemPrompt } from './prompts.js';
import { ApprovalService } from './services/ApprovalService.js';

export { ApiUsage, ContextTokenUsage } from './TokenEstimator.js';
import { ApiUsage } from './TokenEstimator.js';

export interface PluginPatchGroup {
  timestamp: string;
  eventName: string;
  patches: Array<{
    op: 'replace' | 'remove' | 'add';
    path: (string | number)[];
    value?: unknown;
  }>;
}

/**
 * 计算字符串的 MD5 哈希。
 *
 * @param text - 待计算哈希的原始文本
 * @returns 32 位的十六进制 MD5 哈希字符串
 */
export function computeStringHash(text: string): string {
  return createHash('md5').update(text).digest('hex');
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

  /** 用于控制危险操作挂起与恢复的人机协同审批服务 */
  public readonly approvalService: ApprovalService;
  /** 内存缓存的允许执行命令安全白名单 */
  private securityAllowlist: string[] = [];


  /**
   * 实例初始化。
   *
   * @param sessionId - 可选的会话标识，若不传则自动按当前时间戳生成
   */
  constructor(sessionId?: string) {
    // 如果没有传入 sessionId，则使用当前时间戳作为默认会话标识
    this.sessionId = sessionId || Date.now().toString();
    // 实例化独立的人机协同审批协调服务
    this.approvalService = new ApprovalService();

    // 初始化系统指令，确立智能体的工作边界与行为准则
    const systemPrompt = buildSystemPrompt();
    // 将系统提示词作为会话的第一条消息压入历史栈
    this.messageHistory.push({
      role: 'system',
      content: systemPrompt
    });
  }

  /**
   * 从工作区磁盘配置文件中重载命令安全白名单。
   *
   * @returns 最新加载的白名单规则列表
   */
  public loadSecurityAllowlist(): string[] {
    try {
      const filePath = path.resolve(process.cwd(), '.agent/allowed_commands.json');
      if (existsSync(filePath)) {
        const data = readFileSync(filePath, 'utf-8');
        this.securityAllowlist = JSON.parse(data) as string[];
        return this.securityAllowlist;
      }
    } catch {
      // 忽略文件读取异常，回退为空列表
    }
    this.securityAllowlist = [];
    return [];
  }

  /**
   * 将更新后的安全命令白名单持久化存盘，并更新内存缓存。
   *
   * @param commands - 新的白名单规则列表
   */
  public saveSecurityAllowlist(commands: string[]): void {
    try {
      this.securityAllowlist = commands;
      const filePath = path.resolve(process.cwd(), '.agent/allowed_commands.json');
      const dir = path.dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(filePath, JSON.stringify(commands, null, 2), 'utf-8');
    } catch (err) {
      console.error('保存命令安全白名单至磁盘失败:', err);
    }
  }

  /**
   * 获取当前有效的安全命令白名单列表。
   * 若内存缓存为空，则触发一次磁盘加载。
   *
   * @returns 安全命令白名单列表
   */
  public getSecurityAllowlist(): string[] {
    if (this.securityAllowlist.length === 0) {
      this.loadSecurityAllowlist();
    }
    return this.securityAllowlist;
  }

  /**
   * 重新组装并更新会话消息历史中的首条系统提示词（System Prompt）。
   * 此方法保持消息历史中的第 0 个系统消息节点，直接覆写其 content，常用于规则热重载。
   *
   * @param customGlobalRules - 可选的全局规则内容缓存，用于覆盖并锁定
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
   * @param summary - 提炼的摘要内容
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
   * @param files - 最近访问的文件相对路径列表
   */
  public setRecentFiles(files: string[]): void {
    this.recentFiles = files;
  }

  /**
   * 获取当前 System Prompt 的哈希值（用于缓存抖动监测）。
   *
   * @returns 系统提示词的 MD5 哈希字符串，若不存在则返回空字符串
   */
  public getSystemPromptHash(): string {
    if (this.messageHistory.length > 0 && this.messageHistory[0].role === 'system') {
      const content = this.messageHistory[0].content;
      return typeof content === 'string' ? computeStringHash(content) : '';
    }
    return '';
  }

  /**
   * 更新最近一次大模型的 API 结算 Usage。
   *
   * @param usage - 最近一次 API 结算的真实用量
   * @param historyLength - 上次调用时的历史数组长度
   */
  public updateLastApiUsage(usage: ApiUsage, historyLength: number): void {
    this.lastApiUsage = usage;
    this.lastApiHistoryLength = historyLength;
  }

  /**
   * 获取最近一次 API 的 Usage 基准值。
   *
   * @returns 最近一次 API 结算的真实用量，若无则返回 null
   */
  public getLastApiUsage(): ApiUsage | null {
    return this.lastApiUsage;
  }

  /**
   * 获取最近一轮的真实 API Usage 数据与历史数组长度基准。
   * 此方法专供 TokenEstimator 在增量计算时获取基准。
   *
   * @returns 包含上次用量与历史长度的基准对象
   */
  public getLastApiUsageBaseline(): { usage: ApiUsage | null; historyLength: number } {
    return {
      usage: this.lastApiUsage,
      historyLength: this.lastApiHistoryLength
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
   * 增加一条上下文消息。
   *
   * @param message - 待追加的标准模型消息载体对象
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
   * 指针级硬截断（无延迟截断）。
   * 丢弃中间的消息数组，保留 system prompt (index 0) 以及最后的 keepLastN 条消息。
   *
   * @param keepLastN - 保留的最近消息数量
   */
  public truncateHistory(keepLastN: number): void {
    if (this.messageHistory.length <= keepLastN + 1) return;
    const systemMsg = this.messageHistory[0];
    const keptMsgs = this.messageHistory.slice(this.messageHistory.length - keepLastN);
    this.messageHistory = [systemMsg, ...keptMsgs];
  }

  /**
   * 将当前上下文静默序列化落盘到工作区文件。
   *
   * @returns 无返回值的 Promise
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
   * 恢复指定的会话持久化数据覆盖当前内存上下文。
   *
   * @param targetSessionId - 需要恢复加载的目标会话标识符
   * @returns 如果成功读取文件并解析恢复返回 true，文件不存在或解析失败返回 false
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

  private pluginPatches: PluginPatchGroup[] = [];

  /**
   * 追加记录插件运行产生的 Immer Patches 变更。
   *
   * @param eventName - 变更所在的生命周期事件名称
   * @param patches - Immer 产生的变更 Patches 数组
   */
  public addPluginPatches(eventName: string, patches: PluginPatchGroup['patches']): void {
    this.pluginPatches.push({
      timestamp: new Date().toISOString(),
      eventName,
      patches
    });
  }

  /**
   * 提取并清空当前已积压的插件变更补丁记录。
   *
   * @returns 已记录的插件补丁变更列表
   */
  public getAndClearPluginPatches(): PluginPatchGroup[] {
    const patches = this.pluginPatches;
    this.pluginPatches = [];
    return patches;
  }

  /**
   * 覆写整个消息历史记录。
   *
   * @param history - 新的消息历史数组
   */
  public updateHistory(history: ChatCompletionMessageParam[]): void {
    this.messageHistory = history;
  }
}
