import * as fs from 'fs/promises';
import * as path from 'path';
import type { ChatMessage } from '../../ports/driven/LlmPort.js';
import { SessionContext } from '../domain/context.js';

/**
 * 负责会话状态的物理落盘生命周期与上下文回溯。
 */
export class ContextRepository {
  /**
   * 实例初始化。
   *
   * @param context - 会话上下文管理实例
   * @param workspacePath - 可选的工作区根路径，用于重定向持久化状态存储路径
   * @param isTransient - 可选。是否为临时或瞬时会话，若为 true 则在 saveState 时不会物理落盘
   */
  constructor(
    private context: SessionContext,
    private workspacePath?: string,
    private isTransient = false
  ) {}

  /**
   * 将当前上下文静默序列化落盘到工作区文件。
   *
   * @returns 无返回值的 Promise
   */
  public async saveState(): Promise<void> {
    if (this.isTransient) {
      return;
    }
    try {
      const baseDir = this.workspacePath || this.context.appConfig?.workspace || process.cwd();
      // 获取最终会话文件保存的基础目录路径
      const dir = path.join(baseDir, '.myagent/sessions');
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${this.context.getSessionId()}.json`);
      const stateToSave = {
        messages: this.context.getHistory(),
        checkpointSummary: this.context.getCheckpointSummary(),
        recentFiles: this.context.getRecentFiles()
      };
      await fs.writeFile(file, JSON.stringify(stateToSave, null, 2), 'utf-8');
    } catch {
      // 捕获并吞掉异常，静默落盘失败不应阻断核心流程
    }
  }

  /**
   * 恢复指定的会话持久化数据覆盖当前内存上下文。
   *
   * @param targetSessionId - 需要恢复加载的目标会话 ID
   * @returns 成功返回 true，否则返回 false
   */
  public async loadState(targetSessionId: string): Promise<boolean> {
    try {
      const baseDir = this.workspacePath || this.context.appConfig?.workspace || process.cwd();
      // 定位目标反序列化会话 JSON 状态文件的物理路径
      const file = path.join(baseDir, '.myagent/sessions', `${targetSessionId}.json`);
      const data = await fs.readFile(file, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        this.context.updateHistory(parsed);
        this.context.setSessionId(targetSessionId);
        return true;
      } else if (parsed && Array.isArray(parsed.messages)) {
        this.context.updateHistory(parsed.messages);
        this.context.setSessionId(targetSessionId);
        this.context.setCheckpointSummary(parsed.checkpointSummary || null);
        const rawRecent = parsed.recentFiles || [];
        const recentFiles = rawRecent.map((item: unknown) => {
          if (typeof item === 'string') {
            return { filePath: item, opType: 'read' as const };
          }
          const obj = item as { filePath: string; opType: 'read' | 'edit' };
          return {
            filePath: obj.filePath,
            opType: obj.opType
          };
        });
        this.context.setRecentFiles(recentFiles);
        return true;
      }
    } catch {
      // 忽略文件不存在或解析失败的异常，恢复失败时不抛出
    }
    return false;
  }

  /**
   * 执行上下文记忆截断（Context Rollback），安全丢弃最近数轮对话。
   *
   * @param turns - 需要丢弃的交互轮次
   * @returns 返回被弹栈丢弃的历史消息数组（按原本对话顺序排列）
   */
  public rollback(turns: number): ChatMessage[] {
    // 如果无需回退，则直接返回空集合
    if (turns <= 0) return [];

    // 初始化已成功剥离的用户轮次计数
    let poppedTurns = 0;
    // 用于暂存被丢弃的历史节点，以便最终返回
    const dropped: ChatMessage[] = [];

    // 获取当前上下文的引用
    const history = this.context.getHistory();
    // 循环弹栈，始终保留 index 0 的 system 消息（length > 1）
    while (history.length > 1 && poppedTurns < turns) {
      const lastMsg = this.context.popMessage();
      if (lastMsg) {
        dropped.push(lastMsg);
        // 当遇到 user 角色的消息时，说明一整轮（包括它自己和后续助手的回答/工具链）已被完整剥离
        if (lastMsg.role === 'user') {
          poppedTurns++;
        }
      }
    }

    // 状态发生变化后进行静默落盘（后台异步执行，忽略可能产生的文件 IO 异常）
    this.saveState().catch(() => { });

    // 因为是倒序弹出，此处反转数组恢复原有对话的时序逻辑
    return dropped.reverse();
  }
}
