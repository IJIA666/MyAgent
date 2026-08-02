import * as fs from 'fs/promises';
import * as path from 'path';
import type { ChatMessage } from '../../../ports/driven/llm/LlmPort.js';
import { SessionContext, type PendingInteraction } from '../../domain/context.js';
import type { UserQuestion } from '../../../ports/driven/session/InteractionPort.js';
import { logger } from '../../../utils/logger.js';
import { normalizeSkillLearningContinuation } from '../../domain/skill-learning-continuation.js';
import { normalizeSkillLearningCadence } from '../../domain/skill-learning-cadence.js';

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
   * @param sessionsDir - 会话快照目录绝对路径（来自 {@link ApplicationPaths.sessionsDir}）。
   * @param isTransient - 是否为临时会话；为真时跳过落盘。
   */
  constructor(
    private context: SessionContext,
    private sessionsDir: string,
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

    const dir = this.sessionsDir;
    const sessionId = this.normalizeSessionId(this.context.getSessionId());
    const file = path.join(dir, `session_${sessionId}.json`);
    const tempFile = path.join(dir, `.session_${sessionId}.${process.pid}.${Date.now()}.tmp`);
    const stateToSave = {
      version: 6,
      sessionId: this.context.getSessionId(),
      messages: this.context.getHistory(),
      pendingInteraction: this.context.pendingInteraction,
      skillLearningContinuation: this.context.getSkillLearningContinuation(),
      skillLearningCadence: this.context.getSkillLearningCadence(),
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
      // 旧版数组快照没有临时交互与学习状态字段，加载时必须显式清空，
      // 避免复用 ContextRepository 时把上一会话的状态泄漏到目标会话。
      this.context.clearPendingInteraction();
      this.context.clearSkillLearningContinuation();
      this.context.resetSkillLearningCadence();
      return true;
    }

    if (!parsed || typeof parsed !== 'object') {
      return false;
    }

    const state = parsed as {
      sessionId?: unknown;
      messages?: unknown;
    };

    if (!Array.isArray(state.messages)) {
      return false;
    }

    const sessionId = typeof state.sessionId === 'string' && state.sessionId ? state.sessionId : targetSessionId;
    this.context.updateHistory(state.messages as ChatMessage[]);
    this.context.setSessionId(sessionId);

    // 恢复待回答的人机中断交互（仅当快照结构合法且处于 pending 状态时）
    const pending = this.normalizePendingInteraction((parsed as Record<string, unknown>).pendingInteraction);
    if (pending) {
      this.context.restorePendingInteraction(pending);
    } else {
      this.context.clearPendingInteraction();
    }

    const rawContinuation = (parsed as Record<string, unknown>).skillLearningContinuation;
    const continuation = normalizeSkillLearningContinuation(rawContinuation);
    if (continuation) {
      this.context.setSkillLearningContinuation(continuation);
    } else {
      this.context.clearSkillLearningContinuation();
      if (rawContinuation !== undefined && rawContinuation !== null) {
        logger.warn('[ContextRepository] skill_learning_continuation_dropped', {
          component: 'context_repository',
          event: 'skill_learning_continuation_dropped',
          sessionId,
          reason: 'invalid_snapshot_field',
        });
      }
    }

    // 学习节奏 fail-closed 恢复：字段缺失按零累计静默恢复；
    // 字段存在但非法（版本未知、类型错误、负数）归零并记录诊断，
    // 不得阻止消息历史、挂起交互和合法延续状态的恢复。
    const rawCadence = (parsed as Record<string, unknown>).skillLearningCadence;
    const cadence = normalizeSkillLearningCadence(rawCadence);
    if (rawCadence !== undefined && rawCadence !== null
      && !this.isValidCadenceShape(rawCadence)) {
      logger.warn('[ContextRepository] skill_learning_cadence_dropped', {
        component: 'context_repository',
        event: 'skill_learning_cadence_dropped',
        sessionId,
        reason: 'invalid_snapshot_field',
      });
    }
    this.context.setSkillLearningCadence(cadence);

    return true;
  }

  /**
   * 判断学习节奏快照字段是否为合法结构（版本 2 且模型循环累计为非负整数）。
   *
   * @param value - 快照中的原始字段
   * @returns 结构合法返回 true
   */
  private isValidCadenceShape(value: unknown): boolean {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const raw = value as Record<string, unknown>;
    return raw.version === 2
      && typeof raw.accumulatedModelLoops === 'number'
      && Number.isInteger(raw.accumulatedModelLoops)
      && (raw.accumulatedModelLoops as number) >= 0;
  }

  /**
   * 规范化并校验待回答的人机中断交互快照。
   * 仅支持新版 questions[] 载荷格式；旧版 title/options 载荷被安全丢弃。
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

    if (typeof raw.id !== 'string' ||
      typeof raw.toolName !== 'string' ||
      typeof raw.toolCallId !== 'string' ||
      typeof raw.createdAt !== 'number' ||
      raw.state !== 'pending'
    ) {
      return null;
    }

    // 仅识别新格式（payload.questions 数组）；旧版 title/options 载荷安全丢弃
    const questions = this.normalizeQuestions(payload);
    if (!questions) {
      return null;
    }

    return {
      id: raw.id,
      toolName: raw.toolName,
      toolCallId: raw.toolCallId,
      createdAt: raw.createdAt,
      state: 'pending',
      answer: undefined,
      payload: { questions }
    };
  }

  /**
   * 规范化 questions 载荷结构。
   * 若 payload 不包含合法 questions，返回 null 表示应丢弃。
   */
  private normalizeQuestions(payload: unknown): UserQuestion[] | null {
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    const raw = payload as Record<string, unknown>;
    const rawQuestions = raw.questions;
    if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
      return null;
    }
    const questions: UserQuestion[] = rawQuestions.map((item: unknown) => {
      const q = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
      const options = Array.isArray(q.options) ? q.options.map((opt: unknown) => {
        const o = (opt && typeof opt === 'object' ? opt : {}) as Record<string, unknown>;
        return {
          label: typeof o.label === 'string' ? o.label : '',
          description: typeof o.description === 'string' ? o.description : undefined
        };
      }).filter(o => o.label.length > 0) : undefined;

      const mode = typeof q.mode === 'string' ? q.mode : 'single-select';
      const allowedModes = ['single-select', 'multi-select', 'free-text', 'single-select-or-text'];

      return {
        id: typeof q.id === 'string' ? q.id : '',
        header: typeof q.header === 'string' ? q.header : '',
        question: typeof q.question === 'string' ? q.question : '',
        mode: (allowedModes.includes(mode) ? mode : 'single-select') as UserQuestion['mode'],
        options: options && options.length > 0 ? options : undefined
      };
    }).filter(q => q.id.length > 0 && q.question.length > 0);

    return questions.length > 0 ? questions : null;
  }

  /**
   * 构造读取候选路径。
   *
   * @param targetSessionId - 目标会话 ID。
   * @returns 候选文件路径列表。
   */
  private async getStateFileCandidates(targetSessionId: string): Promise<string[]> {
    const dir = this.sessionsDir;
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
