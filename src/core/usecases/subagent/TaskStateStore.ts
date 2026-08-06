import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SubagentContextPolicy } from '../../../ports/driving/SubagentExecutionPort.js';
import type { SubagentTranscriptStore } from './SubagentTranscriptStore.js';
import {
  cloneTaskState,
  isLegalTaskTransition,
  isSafeTaskId,
  isTaskDescription,
  isTaskStatus,
  isTerminalTaskStatus,
  stripControlCharacters,
  type TaskMode,
  type TaskStateFile,
  type TaskStateRecord,
  type TaskStatus,
  type TaskUsage,
} from './task-state.js';

/**
 * 父会话范围内的任务索引仓储。
 * 所有状态提交都经过同一条写队列、同目录临时文件和 rename，避免终态竞争留下半份索引。
 */
export class TaskStateStore {
  /** 已加载的任务记录。 */
  private readonly records = new Map<string, TaskStateRecord>();
  /** 当前父会话索引文件的串行写入队列。 */
  private writeQueue: Promise<void> = Promise.resolve();
  /** 当前绑定的父会话 ID；恢复会话时随控制面一起切换。 */
  private parentSessionId: string;
  /** 是否已经完成首次加载和旧任务恢复。 */
  private initialized = false;
  /** 初始化 Promise，合并并发首次访问。 */
  private initialization?: Promise<void>;

  /**
   * @param subagentsDir - 应用路径提供的子代理根目录
   * @param parentSessionId - 当前父会话 ID
   * @param transcriptStore - 可选 transcript 联动仓储
   */
  constructor(
    private readonly subagentsDir: string,
    parentSessionId: string,
    private readonly transcriptStore?: SubagentTranscriptStore,
  ) {
    this.parentSessionId = parentSessionId;
  }

  /** 返回经过父 session 哈希隔离的任务索引路径。 */
  public getTasksPath(): string {
    const parentHash = createHash('sha256').update(this.parentSessionId, 'utf8').digest('hex');
    return join(this.subagentsDir, parentHash, 'tasks.json');
  }

  /**
   * 加载当前 session 索引，并把上次进程遗留的非终态收敛为 interrupted。
   *
   * @returns 初始化完成 Promise
   */
  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (!this.initialization) {
      this.initialization = this.loadAndRecover();
    }
    await this.initialization;
    this.initialized = true;
  }

  /** 创建一个 pending 任务；重复 agentId、非法索引或容量不足直接拒绝。 */
  public async create(
    input: {
      agentId: string;
      description: string;
      agentType: string;
      contextPolicy: SubagentContextPolicy;
      mode: TaskMode;
    },
    maxInFlight?: number,
  ): Promise<TaskStateRecord> {
    await this.initialize();
    if (!isSafeTaskId(input.agentId) || !isTaskDescription(input.description)) {
      throw new Error('任务索引参数不符合安全边界');
    }
    // 容量检查与占位创建必须处于同一同步段（records 为同步 Map，无 await 竞争），
    // 否则两个并发提交会同时通过旧数量检查，突破在途上限。
    if (this.records.has(input.agentId)) {
      throw new Error('任务 ID 已存在');
    }
    if (maxInFlight !== undefined) {
      const inFlightCount = [...this.records.values()]
        .filter(record => !isTerminalTaskStatus(record.status))
        .length;
      if (inFlightCount >= maxInFlight) {
        throw new CapacityExceededError(`子代理在途任务已达到容量上限: ${maxInFlight}`);
      }
    }
    const now = new Date().toISOString();
    const record: TaskStateRecord = {
      version: 1,
      agentId: input.agentId,
      parentSessionId: this.parentSessionId,
      description: input.description.trim(),
      agentType: input.agentType,
      contextPolicy: input.contextPolicy,
      mode: input.mode,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.agentId, record);
    await this.persist();
    return cloneTaskState(record);
  }

  /**
   * 原子提交状态迁移；终态竞争时只有第一个调用成功。
   *
   * @param agentId - 任务 ID
   * @param status - 目标状态
   * @param details - 可选启动、终态、错误和用量信息
   * @returns 迁移成功后的记录；非法或竞争失败返回 undefined
   */
  public async transition(
    agentId: string,
    status: TaskStatus,
    details: {
      startedAt?: string;
      endedAt?: string;
      errorSummary?: string;
      usage?: TaskUsage;
    } = {},
  ): Promise<TaskStateRecord | undefined> {
    await this.initialize();
    const current = this.records.get(agentId);
    if (!current || !isLegalTaskTransition(current.status, status)) {
      return undefined;
    }
    const now = new Date().toISOString();
    const updated: TaskStateRecord = {
      ...current,
      status,
      updatedAt: now,
      ...(details.startedAt ? { startedAt: details.startedAt } : {}),
      ...(details.endedAt ? { endedAt: details.endedAt } : {}),
      ...(details.errorSummary ? { errorSummary: sanitizeSummary(details.errorSummary) } : {}),
      ...(details.usage ? { usage: { ...details.usage } } : {}),
    };
    this.records.set(agentId, updated);
    await this.persist();
    return cloneTaskState(updated);
  }

  /** 将任务标记为已通知；重复调用返回 false 且不重复写入。 */
  public async markNotified(agentId: string): Promise<boolean> {
    await this.initialize();
    const current = this.records.get(agentId);
    if (!current || !isTerminalTaskStatus(current.status) || current.notified === true) {
      return false;
    }
    const updated: TaskStateRecord = {
      ...current,
      notified: true,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(agentId, updated);
    await this.persist();
    return true;
  }

  /** 更新任务的前台/后台阻塞属性，不改变生命周期状态。 */
  public async updateMode(agentId: string, mode: TaskMode): Promise<TaskStateRecord | undefined> {
    await this.initialize();
    const current = this.records.get(agentId);
    if (!current || isTerminalTaskStatus(current.status) || current.mode === mode) {
      return current ? cloneTaskState(current) : undefined;
    }
    const updated: TaskStateRecord = {
      ...current,
      mode,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(agentId, updated);
    await this.persist();
    return cloneTaskState(updated);
  }

  /** 返回按创建时间升序的安全任务索引副本。 */
  public async list(): Promise<readonly TaskStateRecord[]> {
    await this.initialize();
    return [...this.records.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(cloneTaskState);
  }

  /** 返回当前父会话下指定任务的安全索引副本。 */
  public async get(agentId: string): Promise<TaskStateRecord | undefined> {
    await this.initialize();
    const record = this.records.get(agentId);
    return record ? cloneTaskState(record) : undefined;
  }

  /** 关闭索引前等待最后一次原子写入完成。 */
  public async flush(): Promise<void> {
    await this.writeQueue;
  }

  /**
   * 恢复 CLI 会话后切换任务索引的父 session 边界。
   * 该操作只允许由已停止旧任务的协调器调用，切换后重新加载新 session 的索引。
   *
   * @param parentSessionId - 恢复后的父会话 ID
   */
  public async rebindParentSession(parentSessionId: string): Promise<void> {
    if (parentSessionId === this.parentSessionId) {
      return;
    }
    await this.flush();
    this.parentSessionId = parentSessionId;
    this.records.clear();
    this.initialized = false;
    this.initialization = undefined;
    await this.initialize();
  }

  /** 读取、校验并恢复旧进程遗留任务。 */
  private async loadAndRecover(): Promise<void> {
    const file = this.getTasksPath();
    let parsed: TaskStateFile | undefined;
    try {
      parsed = JSON.parse(await readFile(file, 'utf8')) as TaskStateFile;
    } catch (error: unknown) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
    if (parsed?.version === 1 && Array.isArray(parsed.tasks)) {
      for (const raw of parsed.tasks) {
        if (!isValidRecord(raw, this.parentSessionId)) {
          continue;
        }
        const recovered = isTerminalTaskStatus(raw.status)
          ? cloneTaskState(raw)
          : {
            ...cloneTaskState(raw),
            status: 'interrupted' as const,
            endedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            errorSummary: '上次进程结束时任务未进入终态',
          };
        this.records.set(recovered.agentId, recovered);
        if (!isTerminalTaskStatus(raw.status) && this.transcriptStore) {
          await this.transcriptStore.updateStatus(
            this.parentSessionId,
            raw.agentId,
            'interrupted',
            '上次进程结束时任务未进入终态',
          );
        }
      }
    }
    const beforeTrimCount = this.records.size;
    this.trimTerminalRecords();
    if (
      this.records.size !== beforeTrimCount
      || [...this.records.values()].some(record => record.status === 'interrupted')
    ) {
      await this.persist();
    }
  }

  /** 通过单文件串行队列写入索引，并清理最旧终态。 */
  private async persist(): Promise<void> {
    this.trimTerminalRecords();
    const snapshot: TaskStateFile = {
      version: 1,
      tasks: [...this.records.values()].map(cloneTaskState),
    };
    const previous = this.writeQueue;
    const current = previous.then(() => this.writeAtomic(snapshot), () => this.writeAtomic(snapshot));
    this.writeQueue = current;
    await current;
  }

  /** 终态最多保留最近 100 条，非终态永不因容量清理。 */
  private trimTerminalRecords(): void {
    const terminal = [...this.records.values()]
      .filter(record => isTerminalTaskStatus(record.status))
      .sort((left, right) => (left.endedAt ?? left.updatedAt).localeCompare(right.endedAt ?? right.updatedAt));
    while (terminal.length > 100) {
      const oldest = terminal.shift();
      if (oldest) {
        this.records.delete(oldest.agentId);
      }
    }
  }

  /** 同目录临时文件 + rename 的原子保存实现。 */
  private async writeAtomic(snapshot: TaskStateFile): Promise<void> {
    const file = this.getTasksPath();
    const directory = dirname(file);
    const temporary = join(directory, `.tasks.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, JSON.stringify(snapshot, null, 2), 'utf8');
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

/** 校验磁盘记录，拒绝跨 session、非法 ID 和含 prompt 的异常对象。 */
function isValidRecord(value: unknown, parentSessionId: string): value is TaskStateRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<TaskStateRecord>;
  return record.version === 1
    && record.parentSessionId === parentSessionId
    && isSafeTaskId(record.agentId)
    && isTaskDescription(record.description)
    && typeof record.agentType === 'string'
    && record.agentType.length > 0
    && (record.contextPolicy === 'fresh' || record.contextPolicy === 'history-replay' || record.contextPolicy === 'exact-fork')
    && (record.mode === 'foreground' || record.mode === 'background')
    && isTaskStatus(record.status)
    && typeof record.createdAt === 'string'
    && typeof record.updatedAt === 'string';
}

/** 低敏错误摘要限制长度并去除控制字符。 */
function sanitizeSummary(value: string): string {
  return stripControlCharacters(value).slice(0, 500);
}

/** 判断文件是否因不存在而读取失败。 */
function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT';
}

/** 任务在途容量已满时的稳定拒绝错误。 */
export class CapacityExceededError extends Error {
  /** 标识容量拒绝，供任务管理器映射为稳定错误码。 */
  public readonly code = 'SUBAGENT_CAPACITY_EXCEEDED';

  /**
   * @param message - 低敏错误说明
   */
  constructor(message: string) {
    super(message);
    this.name = 'CapacityExceededError';
  }
}
