import * as fs from 'fs/promises';
import * as path from 'path';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import { buildSystemPrompt } from './prompts.js';

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
  private pinnedSkills: string[] = [];
  private disabledSkills: string[] = [];

  /**
   * 实例初始化。
   * @param sessionId 可选的会话标识，若不传则自动按当前时间戳生成。
   */
  constructor(sessionId?: string) {
    // 如果没有传入 sessionId，则使用当前时间戳作为默认会话标识
    this.sessionId = sessionId || Date.now().toString();

    // 初始化系统指令，确立智能体的工作边界与行为准则
    const systemPrompt = buildSystemPrompt(this.pinnedSkills, this.disabledSkills);
    // 将系统提示词作为会话的第一条消息压入历史栈
    this.messageHistory.push({
      role: 'system',
      content: systemPrompt
    });
  }

  /**
   * 强行置顶某项技能，重新构建系统提示词，更新第一条消息。
   */
  public pinSkill(name: string): void {
    if (!this.pinnedSkills.includes(name)) {
      this.pinnedSkills.push(name);
      // 如果被强制挂载了，同时也从黑名单里移出来
      const dIndex = this.disabledSkills.indexOf(name);
      if (dIndex !== -1) {
        this.disabledSkills.splice(dIndex, 1);
      }
      this.rebuildSystemPrompt();
    }
  }

  /**
   * 取消置顶某项技能，重新构建系统提示词，更新第一条消息。
   */
  public unpinSkill(name: string): void {
    const index = this.pinnedSkills.indexOf(name);
    if (index !== -1) {
      this.pinnedSkills.splice(index, 1);
      this.rebuildSystemPrompt();
    }
  }

  /**
   * 将某个技能彻底拉黑（禁止拉取，并在下一次构建系统提示词时隐藏索引）
   */
  public disableSkill(name: string): void {
    if (!this.disabledSkills.includes(name)) {
      this.disabledSkills.push(name);
      // 如果之前被置顶过，也强制踢出
      const pIndex = this.pinnedSkills.indexOf(name);
      if (pIndex !== -1) {
        this.pinnedSkills.splice(pIndex, 1);
      }
      this.rebuildSystemPrompt();
    }
  }

  /**
   * 从黑名单中移除某技能（恢复为默认的按需拉取模式）
   */
  public enableSkill(name: string): void {
    const index = this.disabledSkills.indexOf(name);
    if (index !== -1) {
      this.disabledSkills.splice(index, 1);
      this.rebuildSystemPrompt();
    }
  }

  public getPinnedSkills(): string[] {
    return this.pinnedSkills;
  }

  public getDisabledSkills(): string[] {
    return this.disabledSkills;
  }

  /**
   * 重新构建系统指令并刷新内存中第一条 System 消息
   */
  public rebuildSystemPrompt(): void {
    if (this.messageHistory.length > 0 && this.messageHistory[0].role === 'system') {
      this.messageHistory[0].content = buildSystemPrompt(this.pinnedSkills, this.disabledSkills);
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
        messages: this.messageHistory
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
        this.pinnedSkills = [];
        this.disabledSkills = [];
        this.sessionId = targetSessionId;
        return true;
      } else if (parsed && Array.isArray(parsed.messages)) {
        // 新版本读取，初始化时清空临时激活列表
        this.messageHistory = parsed.messages;
        this.pinnedSkills = [];
        this.disabledSkills = [];
        this.sessionId = targetSessionId;
        return true;
      }
    } catch {
      // 忽略文件不存在或解析失败的异常，恢复失败时不抛出
    }
    // 恢复失败，返回 false
    return false;
  }
}
