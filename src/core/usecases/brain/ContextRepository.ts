import * as fs from 'fs/promises';
import * as path from 'path';
import type { ChatMessage } from '../../../ports/driven/llm/LlmPort.js';
import { SessionContext, type PendingInteraction, type QuestionPayload } from '../../domain/context.js';
import { logger } from '../../../utils/logger.js';

/**
 * 负责会话状态的持久化保存、兼容读取与回滚恢复。
 */
export class ContextRepository {
  /** 串行化保存操作，避免并发写入相互覆盖。 */
  private saveQueue: Promise<void> = Promise.resolve();

  /**
   * 创建仓储实例。
   *
   * @param context - 会话上下文实例。
   * @param workspacePath - 可选的工作区根路径。
   * @param isTransient - 是否为临时会话；为真时跳过落盘。
   */
  constructor(
    private context: SessionContext,
    private workspacePath?: string,
    private isTransient = false
  ) {}

  /**
   * 将当前上下文快照保存到会话文件。
   *
   * 保存过程采用同目录临时文件写入，再重命名替换目标文件的方式。
   *
   * @returns 无返回值的 Promise。
   */
  public async saveState(): Promise<void> {
    if (this.isTransient) {
      return;
    }

    const task = this.saveQueue.then(
      () => this.persistState(),
      () => this.persistState()
    );
    this.saveQueue = task.then(() => undefined, () => undefined);
    await task;
  }

  /**
   * 读取指定会话的持久化状态，并覆盖当前上下文。
   *
   * @param targetSessionId - 目标会话 ID。
   * @returns 成功返回 true，否则返回 false。
   */
  public async loadState(targetSessionId: string): Promise<boolean> {
    const candidates = await this.getStateFileCandidates(targetSessionId);

    for (const file of candidates) {
      try {
        const data = await fs.readFile(file, 'utf-8');
        const parsed = JSON.parse(data) as unknown;
        if (this.applyLoadedState(parsed, targetSessionId)) {
          return true;
        }
      } catch (error) {
        if (!this.isNotFoundError(error)) {
          logger.warn('[ContextRepository] snapshot_load_failed', {
            component: 'context_repository',
            event: 'snapshot_load_failed',
            sessionId: targetSessionId,
            file,
            reason: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    return false;
  }

  /**
   * 执行上下文回滚，移除最近若干轮对话。
   *
   * @param turns - 需要丢弃的用户轮次。
   * @returns 被回滚出去的历史消息，保持原始顺序。
   */
  public rollback(turns: number): ChatMessage[] {
    if (turns <= 0) return [];

    let poppedTurns = 0;
    const dropped: ChatMessage[] = [];
    const history = this.context.getHistory();

    while (history.length > 1 && poppedTurns < turns) {
      const lastMsg = this.context.popMessage();
      if (lastMsg) {
        dropped.push(lastMsg);
        if (lastMsg.role === 'user') {
          poppedTurns++;
        }
      }
    }

    this.saveState().catch(() => {
      // 回滚后静默落盘失败，不阻塞主流程。
    });

    return dropped.reverse();
  }

  /**
   * 实际执行快照写入。
   */
  private async persistState(): Promise<void> {
    if (this.isTransient) {
      return;
    }

    const baseDir = this.workspacePath || this.context.appConfig?.workspace || process.cwd();
    const dir = path.join(baseDir, '.myagent', 'sessions');
    const sessionId = this.normalizeSessionId(this.context.getSessionId());
    const file = path.join(dir, `session_${sessionId}.json`);
    const tempFile = path.join(dir, `.session_${sessionId}.${process.pid}.${Date.now()}.tmp`);
    const stateToSave = {
      version: 3,
      sessionId: this.context.getSessionId(),
      messages: this.context.getHistory(),
      checkpointSummary: this.context.getCheckpointSummary(),
      recentFiles: this.context.getRecentFiles(),
      pendingInteraction: this.context.pendingInteraction
    };

    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(tempFile, JSON.stringify(stateToSave, null, 2), 'utf-8');
      await this.replaceSnapshot(tempFile, file);
      logger.debug('[ContextRepository] snapshot_saved', {
        component: 'context_repository',
        event: 'snapshot_saved',
        sessionId: this.context.getSessionId(),
        file
      });
    } catch (error) {
      logger.warn('[ContextRepository] snapshot_save_failed', {
        component: 'context_repository',
        event: 'snapshot_save_failed',
        sessionId: this.context.getSessionId(),
        file,
        reason: error instanceof Error ? error.message : String(error)
      });
    } finally {
      await fs.rm(tempFile, { force: true }).catch(() => undefined);
    }
  }

  /**
   * 将临时快照替换为正式快照，失败时保留旧文件。
   *
   * @param tempFile - 临时文件路径。
   * @param file - 正式快照路径。
   */
  private async replaceSnapshot(tempFile: string, file: string): Promise<void> {
    const backupFile = `${file}.bak-${process.pid}-${Date.now()}`;
    let hasBackup = false;

    try {
      try {
        await fs.rename(file, backupFile);
        hasBackup = true;
      } catch (backupError) {
        if (!this.isNotFoundError(backupError)) {
          throw backupError;
        }
      }

      try {
        await fs.rename(tempFile, file);
      } catch (replaceError) {
        if (hasBackup) {
          try {
            await fs.rename(backupFile, file);
          } catch (restoreError) {
            throw new Error(`Failed to restore snapshot ${file}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`, {
              cause: restoreError
            });
          }
        }
        throw replaceError;
      }

      if (hasBackup) {
        await fs.rm(backupFile, { force: true });
      }
    } catch (error) {
      await fs.rm(tempFile, { force: true }).catch(() => undefined);
      throw new Error(`Failed to replace snapshot ${file}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error
      });
    }
  }

  /**
   * 将读取到的对象应用到当前会话上下文。
   *
   * @param parsed - 解析后的快照内容。
   * @param targetSessionId - 目标会话 ID。
   * @returns 是否成功应用。
   */
  private applyLoadedState(parsed: unknown, targetSessionId: string): boolean {
    if (Array.isArray(parsed)) {
      this.context.updateHistory(parsed as ChatMessage[]);
      this.context.setSessionId(targetSessionId);
      return true;
    }

    if (!parsed || typeof parsed !== 'object') {
      return false;
    }

    const state = parsed as {
      sessionId?: unknown;
      messages?: unknown;
      checkpointSummary?: unknown;
      recentFiles?: unknown;
    };

    if (!Array.isArray(state.messages)) {
      return false;
    }

    const sessionId = typeof state.sessionId === 'string' && state.sessionId ? state.sessionId : targetSessionId;
    this.context.updateHistory(state.messages as ChatMessage[]);
    this.context.setSessionId(sessionId);
    this.context.setCheckpointSummary(typeof state.checkpointSummary === 'string' ? state.checkpointSummary : null);
    this.context.setRecentFiles(this.normalizeRecentFiles(state.recentFiles));

    // 恢复待回答的人机中断交互（仅当快照结构合法且处于 pending 状态时）
    const pending = this.normalizePendingInteraction((parsed as Record<string, unknown>).pendingInteraction);
    if (pending) {
      this.context.restorePendingInteraction(pending);
    } else {
      this.context.clearPendingInteraction();
    }

    return true;
  }

  /**
   * 规范化并校验待回答的人机中断交互快照。
   *
   * @param value - 原始快照字段值
   * @returns 合法的 PendingInteraction；非法或非 pending 状态则返回 null
   */
  private normalizePendingInteraction(value: unknown): PendingInteraction | null {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const raw = value as Record<string, unknown>;
    const payload = raw.payload;
    const title = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).title : undefined;
    const options = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).options : undefined;
    const multiSelect = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).multiSelect : undefined;
    const allowFreeInput = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).allowFreeInput : undefined;

    if (
      typeof raw.id !== 'string' ||
      typeof raw.toolName !== 'string' ||
      typeof raw.toolCallId !== 'string' ||
      typeof raw.createdAt !== 'number' ||
      raw.state !== 'pending' ||
      typeof title !== 'string'
    ) {
      return null;
    }

    const normalizedPayload: QuestionPayload = {
      title,
      options: Array.isArray(options) ? options.filter((item): item is string => typeof item === 'string') : undefined,
      multiSelect: typeof multiSelect === 'boolean' ? multiSelect : undefined,
      allowFreeInput: typeof allowFreeInput === 'boolean' ? allowFreeInput : undefined
    };

    return {
      id: raw.id,
      toolName: raw.toolName,
      toolCallId: raw.toolCallId,
      createdAt: raw.createdAt,
      state: 'pending',
      payload: normalizedPayload
    };
  }

  /**
   * 规范化 recentFiles 字段。
   *
   * @param value - 原始字段值。
   * @returns 统一后的 recentFiles 列表。
   */
  private normalizeRecentFiles(value: unknown): { filePath: string; opType: 'read' | 'edit' }[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => {
        if (typeof item === 'string') {
          return { filePath: item, opType: 'read' as const };
        }
        if (!item || typeof item !== 'object') {
          return null;
        }

        const file = item as { filePath?: unknown; opType?: unknown };
        if (typeof file.filePath !== 'string' || !file.filePath) {
          return null;
        }

        return {
          filePath: file.filePath,
          opType: file.opType === 'edit' ? 'edit' : 'read'
        };
      })
      .filter((item): item is { filePath: string; opType: 'read' | 'edit' } => item !== null);
  }

  /**
   * 构造读取候选路径，兼容新旧文件名。
   *
   * @param targetSessionId - 目标会话 ID。
   * @returns 候选文件路径列表。
   */
  private async getStateFileCandidates(targetSessionId: string): Promise<string[]> {
    const baseDir = this.workspacePath || this.context.appConfig?.workspace || process.cwd();
    const dir = path.join(baseDir, '.myagent', 'sessions');
    const sessionId = this.normalizeSessionId(targetSessionId);
    const candidates = new Set<string>();

    candidates.add(path.join(dir, `session_${sessionId}.json`));
    candidates.add(path.join(dir, `${sessionId}.json`));

    if (targetSessionId !== sessionId) {
      candidates.add(path.join(dir, targetSessionId));
      candidates.add(path.join(dir, `${targetSessionId}.json`));
    }

    const backups = await this.collectBackupFiles(dir, sessionId);
    for (const backup of backups) {
      candidates.add(backup);
    }

    return [...candidates];
  }

  /**
   * 收集同一会话的备用快照文件。
   *
   * @param dir - 会话目录。
   * @param sessionId - 规范化后的会话 ID。
   * @returns 按时间优先的备用文件列表。
   */
  private async collectBackupFiles(dir: string, sessionId: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(dir);
      return entries
        .filter((entry) => entry.startsWith(`session_${sessionId}.json.bak-`))
        .map((entry) => path.join(dir, entry))
        .sort((a, b) => b.localeCompare(a));
    } catch {
      return [];
    }
  }

  /**
   * 统一去除会话 ID 的前缀和扩展名。
   *
   * @param sessionId - 原始会话标识。
   * @returns 归一化后的会话 ID。
   */
  private normalizeSessionId(sessionId: string): string {
    const withoutExtension = sessionId.endsWith('.json') ? sessionId.slice(0, -5) : sessionId;
    return withoutExtension.startsWith('session_') ? withoutExtension.slice('session_'.length) : withoutExtension;
  }

  /**
   * 判断读取失败是否为文件不存在。
   *
   * @param error - 捕获到的异常。
   * @returns 是否为缺失文件。
   */
  private isNotFoundError(error: unknown): boolean {
    return !!error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT';
  }
}
