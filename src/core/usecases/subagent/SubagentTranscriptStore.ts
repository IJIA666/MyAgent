import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ChatMessage } from '../../../ports/driven/llm/LlmPort.js';
import { sanitizeDiagnosticData } from '../../../utils/diagnostic-sanitizer.js';

/** 子代理 transcript 的可观察终态。 */
export type SubagentTranscriptStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'killed'
  | 'interrupted';

/** 冻结模型身份，不保存 API key。 */
export interface SubagentTranscriptModel {
  /** 模型 profile/provider 标识。 */
  readonly provider?: string;
  /** 实际模型名。 */
  readonly model: string;
}

/** 版本化子代理 transcript 记录。 */
export interface SubagentTranscriptRecord {
  /** transcript 格式版本。 */
  readonly version: 1;
  /** 系统生成的子代理 ID。 */
  readonly agentId: string;
  /** 原始父 session ID；路径使用其哈希，不直接拼接。 */
  readonly parentSessionId: string;
  /** 子代理类型。 */
  readonly agentType: string;
  /** 上下文策略。 */
  readonly contextPolicy: string;
  /** 当前状态。 */
  readonly status: SubagentTranscriptStatus;
  /** 开始时间。 */
  readonly startedAt: string;
  /** 终态时间。 */
  readonly endedAt?: string;
  /** 冻结模型身份。 */
  readonly model: SubagentTranscriptModel;
  /** 未经扫描修改的原始消息。 */
  readonly messages: readonly ChatMessage[];
  /** 交付给父 Agent 的扫描副本。 */
  readonly deliveredOutput?: string;
  /** 扫描器版本。 */
  readonly scanVersion?: string;
  /** 命中的扫描规则。 */
  readonly scanRuleIds: readonly string[];
  /** 低敏失败摘要。 */
  readonly errorSummary?: string;
}

/** transcript 写入初始化参数。 */
export type SubagentTranscriptInput = SubagentTranscriptRecord;

/**
 * 子代理 transcript 存储。
 * 每个文件通过同目录临时文件和 rename 原子替换，并按路径串行化并发写入。
 */
export class SubagentTranscriptStore {
  /** 正在进行的同路径写入队列。 */
  private readonly queues = new Map<string, Promise<void>>();
  /** 已成功写入的状态，用于阻止终态回退。 */
  private readonly statuses = new Map<string, SubagentTranscriptStatus>();

  /**
   * @param subagentsDir - 应用路径提供的子代理根目录
   */
  constructor(private readonly subagentsDir: string) {}

  /**
   * 计算安全 transcript 路径。
   *
   * @param parentSessionId - 父 session ID
   * @param agentId - 系统生成的子代理 ID
   * @returns `<subagentsDir>/<父 session 哈希>/<agentId>/transcript.json`
   */
  public getTranscriptPath(parentSessionId: string, agentId: string): string {
    const parentKey = createHash('sha256').update(parentSessionId, 'utf8').digest('hex');
    const agentKey = /^[a-zA-Z0-9_-]+$/.test(agentId)
      ? agentId
      : createHash('sha256').update(agentId, 'utf8').digest('hex');
    return join(this.subagentsDir, parentKey, agentKey, 'transcript.json');
  }

  /**
   * 原子保存一条 transcript。
   *
   * @param record - 待写入记录
   * @returns 写入完成的 Promise
   */
  public async write(record: SubagentTranscriptInput): Promise<void> {
    const file = this.getTranscriptPath(record.parentSessionId, record.agentId);
    // 同步快速失败：终态不可回退（含 cancelled -> killed 例外）。
    const currentStatus = this.statuses.get(file);
    if (
      currentStatus
      && isTerminalStatus(currentStatus)
      && currentStatus !== record.status
      && !(currentStatus === 'cancelled' && record.status === 'killed')
    ) {
      throw new Error(`transcript 终态不可回退: ${currentStatus} -> ${record.status}`);
    }
    await this.enqueueWrite(file, record, queuedStatus => {
      if (
        queuedStatus
        && isTerminalStatus(queuedStatus)
        && queuedStatus !== record.status
        && !(queuedStatus === 'cancelled' && record.status === 'killed')
      ) {
        throw new Error(`transcript 终态不可回退: ${queuedStatus} -> ${record.status}`);
      }
    });
  }

  /**
   * 恢复路径专用：终态校验后允许新一轮 `running` 记录覆盖（绕过终态回退保护）。
   * 同一 agentId 代表同一逻辑任务，恢复以覆盖语义续写；普通写仍受终态回退保护。
   * 调用方必须先读取旧记录并完成终态校验。
   *
   * @param record - 新一轮 running 基线记录
   */
  public async beginResume(record: SubagentTranscriptInput): Promise<void> {
    const file = this.getTranscriptPath(record.parentSessionId, record.agentId);
    await this.enqueueWrite(file, record, queuedStatus => {
      // 与 write 相反：仅拒绝非终态覆盖；终态 -> running 是恢复的合法路径。
      if (queuedStatus && !isTerminalStatus(queuedStatus)) {
        throw new Error(`transcript 非终态不可恢复覆盖: ${queuedStatus} -> ${record.status}`);
      }
    });
  }

  /**
   * 同路径写队列：串行化并发写入并执行守卫。
   * 进程重启或新 Store 实例也必须读取既有状态，不能靠内存 Map 绕过守卫。
   *
   * @param file - transcript 文件路径
   * @param record - 待写入记录
   * @param guard - 写前守卫；抛错则放弃写入
   */
  private enqueueWrite(
    file: string,
    record: SubagentTranscriptInput,
    guard: (queuedStatus: SubagentTranscriptStatus | undefined) => void,
  ): Promise<void> {
    const previous = this.queues.get(file) ?? Promise.resolve();
    const persist = async (): Promise<void> => {
      const queuedStatus = this.statuses.get(file) ?? await this.readStatus(file);
      guard(queuedStatus);
      await this.writeAtomic(file, record);
      this.statuses.set(file, record.status);
    };
    const task = previous.then(persist, persist);
    this.queues.set(file, task);
    return task.finally(() => {
      if (this.queues.get(file) === task) {
        this.queues.delete(file);
      }
    });
  }

  /**
   * 读取一条已落盘记录，供诊断和测试使用。
   *
   * @param parentSessionId - 父 session ID
   * @param agentId - 子代理 ID
   * @returns 记录；不存在时返回 undefined
   */
  public async read(
    parentSessionId: string,
    agentId: string,
  ): Promise<SubagentTranscriptRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.getTranscriptPath(parentSessionId, agentId), 'utf8')) as SubagentTranscriptRecord;
    } catch (error: unknown) {
      if (isNotFoundError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * 只更新既有 transcript 的任务终态，不为缺失文件伪造正文或消息。
   *
   * @param parentSessionId - 父 session ID
   * @param agentId - 子代理 ID
   * @param status - 新的终态
   * @param errorSummary - 可选低敏错误摘要
   * @returns transcript 存在并完成更新时返回 true
   */
  public async updateStatus(
    parentSessionId: string,
    agentId: string,
    status: SubagentTranscriptStatus,
    errorSummary?: string,
  ): Promise<boolean> {
    if (status === 'running') {
      throw new Error('transcript 状态更新必须提交终态');
    }
    const current = await this.read(parentSessionId, agentId);
    if (!current) {
      return false;
    }
    if (
      isTerminalStatus(current.status)
      && current.status !== status
      && !(current.status === 'cancelled' && status === 'killed')
    ) {
      return false;
    }
    await this.write({
      ...current,
      status,
      endedAt: current.endedAt ?? new Date().toISOString(),
      ...(errorSummary ? { errorSummary: SubagentTranscriptStore.sanitizeErrorSummary(errorSummary) } : {}),
    });
    return true;
  }

  /** 将异常压缩为不携带完整对象和疑似凭据的诊断摘要。 */
  public static sanitizeErrorSummary(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    const sanitized = sanitizeDiagnosticData(raw, 'operational', { maxStringLength: 500 });
    return typeof sanitized === 'string' ? sanitized : '[Unserializable error]';
  }

  /** 执行单次同目录原子替换。 */
  private async writeAtomic(file: string, record: SubagentTranscriptRecord): Promise<void> {
    const directory = dirname(file);
    const temporary = join(directory, `.transcript.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`);
    const serializable = {
      ...record,
      messages: record.messages.map(cloneChatMessage),
      scanRuleIds: [...record.scanRuleIds],
    };
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, JSON.stringify(serializable, null, 2), 'utf8');
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  /** 读取已有 transcript 的状态；文件不存在时返回 undefined。 */
  private async readStatus(file: string): Promise<SubagentTranscriptStatus | undefined> {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as { status?: unknown };
      return isTranscriptStatus(parsed.status) ? parsed.status : undefined;
    } catch (error: unknown) {
      if (isNotFoundError(error)) {
        return undefined;
      }
      throw error;
    }
  }
}

/** 深复制消息及工具调用字段，解除 transcript 与运行中对象的引用耦合。 */
function cloneChatMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    ...(message.tool_calls ? {
      tool_calls: message.tool_calls.map(call => ({
        ...call,
        function: { ...call.function },
      })),
    } : {}),
  };
}

/** 识别不存在文件错误。 */
function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT';
}

/** 判断 transcript 是否已进入不可回退终态。 */
function isTerminalStatus(status: SubagentTranscriptStatus): boolean {
  return status === 'completed'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'killed'
    || status === 'interrupted';
}

/** 判断从磁盘读取的状态是否属于当前版本协议。 */
function isTranscriptStatus(value: unknown): value is SubagentTranscriptStatus {
  return value === 'running'
    || value === 'completed'
    || value === 'failed'
    || value === 'cancelled'
    || value === 'killed'
    || value === 'interrupted';
}
