/**
 * @file Claude 风格后台记忆 Agent 的受限工具入口。
 * 该入口先应用固定的最小工具策略，再通过 ToolRegistry 的统一 ToolGateway 执行；
 * memory 内容、模型输出和父会话模式都不能扩大该固定上限。
 */

import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { ToolRegistryPort } from '../../../ports/driven/tools/ToolRegistryPort.js';
import type {
  ToolPermissionCheckResult,
} from '../../domain/permissions/permission-types.js';
import {
  PermissionSessionState,
  type PermissionSessionSnapshot,
} from '../../domain/permissions/permission-session-state.js';
import {
  createChildTrustedCallContext,
  type TrustedCallContext,
} from '../../domain/permissions/trusted-call-context.js';

/** Claude Read/Grep/Glob 在 MyAgent 中对应的标准只读文件工具。 */
const AUTO_MEMORY_READ_TOOLS = new Set([
  'readFile',
  'readManyFiles',
  'listFiles',
  'grepSearch',
  'globSearch',
]);
/** Claude Bash 在 MyAgent 不同 shell family 下的等价工具。 */
const AUTO_MEMORY_SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
/** Claude Edit/Write 在 MyAgent 中对应的普通写工具。 */
const AUTO_MEMORY_WRITE_TOOLS = new Set(['editFile', 'writeFile']);

/** 受限工具策略的穷尽结果。 */
export type AutoMemoryToolDecision =
  | {
      readonly behavior: 'allow';
      readonly updatedInput: Readonly<Record<string, unknown>>;
    }
  | {
      readonly behavior: 'deny';
      readonly reason: string;
    };

/** 后台记忆 Agent 调用工具前使用的固定策略函数。 */
export type AutoMemoryCanUseTool = (
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  candidate?: ToolPermissionCheckResult,
) => Promise<AutoMemoryToolDecision>;

/** 后台记忆 Agent 初始化选项。 */
export interface AutoMemoryAgentOptions {
  /** 精确默认 memory 根。 */
  readonly memoryDir: string;
  /** 父会话最终权限状态。 */
  readonly parentPermissionState: PermissionSessionState;
  /** 父 caller；子 caller 从其策略版本和验证状态派生。 */
  readonly parentCaller: TrustedCallContext;
  /** 父 Agent 当前实际可见的工具名；子工具面只能取其交集。 */
  readonly parentToolNames: readonly string[];
  /** 子 caller id。 */
  readonly callerId?: string;
  /** 去敏审计来源。 */
  readonly auditSource?: string;
}

/**
 * 创建与 Claude createAutoMemCanUseTool 等价的固定策略。
 *
 * - Read/Grep/Glob 对应的标准文件只读工具直接允许；
 * - Bash/PowerShell 只有在正式工具分析证明为 read 时允许；
 * - editFile/writeFile 只有目标物理路径位于 memory 根时允许；
 * - MCP、Browser、交互、删除、移动、applyPatch 等其他工具全部拒绝。
 *
 * @param memoryDir - 后台 Agent 唯一可写的长期记忆根
 * @returns 不读取 memory 内容的受限工具策略
 */
export function createAutoMemCanUseTool(memoryDir: string): AutoMemoryCanUseTool {
  const physicalMemoryRoot = resolvePhysicalPath(memoryDir);
  return async (toolName, input, candidate) => {
    if (AUTO_MEMORY_READ_TOOLS.has(toolName)) {
      return {
        behavior: 'allow',
        updatedInput: freezeInput(input),
      };
    }

    if (AUTO_MEMORY_SHELL_TOOLS.has(toolName)) {
      if (
        candidate?.kind === 'allow'
        && candidate.evidence?.sideEffect === 'read'
      ) {
        return {
          behavior: 'allow',
          updatedInput: freezeInput(input),
        };
      }
      return {
        behavior: 'deny',
        reason: '后台记忆 Agent 只允许经过正式分析证明为只读的 Shell 命令',
      };
    }

    if (AUTO_MEMORY_WRITE_TOOLS.has(toolName)) {
      const targetPath = input.targetPath;
      if (
        typeof targetPath === 'string'
        && isPhysicalPathInside(
          physicalMemoryRoot,
          resolvePhysicalPath(targetPath, memoryDir),
        )
      ) {
        return {
          behavior: 'allow',
          updatedInput: freezeInput(input),
        };
      }
      return {
        behavior: 'deny',
        reason: `后台记忆 Agent 只能编辑精确 memory 根内的文件: ${memoryDir}`,
      };
    }

    return {
      behavior: 'deny',
      reason: '后台记忆 Agent 只允许 Read/Grep/Glob、只读 Shell 和 memory 根内 Edit/Write',
    };
  };
}

/**
 * 受限后台记忆 Agent 工具执行入口。
 * 它复制父权限状态和工具面，并使用独立 background caller；
 * 固定策略通过后仍调用 ToolRegistry，从而继续经过正式 ToolGateway、host cap 与 execution grant。
 */
export class AutoMemoryAgent {
  private readonly permissionState: PermissionSessionState;
  private readonly caller: TrustedCallContext;
  private readonly parentToolNames: ReadonlySet<string>;
  private readonly canUseTool: AutoMemoryCanUseTool;
  private readonly auditSource: string;

  /**
   * @param toolRegistry - 已装配统一 ToolGateway 的工具注册表
   * @param options - memory 根、父权限快照、父 caller 与工具面
   */
  constructor(
    private readonly toolRegistry: ToolRegistryPort,
    options: AutoMemoryAgentOptions,
  ) {
    this.permissionState = PermissionSessionState.fromSnapshot(
      options.parentPermissionState.snapshot(),
    );
    this.caller = createChildTrustedCallContext(
      options.parentCaller,
      options.callerId ?? `auto-memory:${options.parentCaller.caller.callerId}`,
    );
    this.parentToolNames = new Set(options.parentToolNames);
    this.canUseTool = createAutoMemCanUseTool(options.memoryDir);
    this.auditSource = options.auditSource ?? 'extract_memories';
  }

  /**
   * 执行一次受限工具调用。
   *
   * @param toolName - 真实运行时工具名
   * @param input - 工具参数
   * @param options - 取消、关联 id 与超时
   * @returns 统一 ToolGateway 返回的执行 outcome
   */
  public async executeTool(
    toolName: string,
    input: Readonly<Record<string, unknown>>,
    options: {
      readonly signal?: AbortSignal;
      readonly toolCallId?: string;
      readonly timeoutMs?: number;
    } = {},
  ): Promise<Awaited<ReturnType<ToolRegistryPort['callTool']>>> {
    if (!this.parentToolNames.has(toolName)) {
      throw new Error(`后台记忆 Agent 无权扩展父工具面: ${toolName}`);
    }

    const executableInput = cloneInput(input);
    const candidate = await this.toolRegistry.evaluateToolPermissionCandidate?.(
      toolName,
      executableInput,
      this.permissionState,
    );
    const restriction = await this.canUseTool(
      toolName,
      executableInput,
      candidate,
    );
    if (restriction.behavior === 'deny') {
      throw new Error(`后台记忆 Agent 工具拒绝: ${restriction.reason}`);
    }

    return await this.toolRegistry.callTool(
      toolName,
      cloneInput(restriction.updatedInput),
      undefined,
      undefined,
      options.signal,
      options.toolCallId,
      options.timeoutMs,
      {
        securityContext: {
          caller: this.caller,
          permissionState: this.permissionState,
          approvalAllowed: false,
          auditSource: this.auditSource,
        },
      },
    );
  }

  /**
   * 获取子 Agent 的独立权限快照，供审计和测试验证不扩权。
   *
   * @returns 不可变权限快照
   */
  public getPermissionSnapshot(): PermissionSessionSnapshot {
    return this.permissionState.snapshot();
  }

  /**
   * 获取独立 caller。
   *
   * @returns background/subagent caller
   */
  public getCaller(): TrustedCallContext {
    return this.caller;
  }
}

/** 深复制并冻结工具输入，禁止策略检查后由调用方篡改。 */
function freezeInput(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return deepFreeze(cloneInput(input));
}

/** 使用平台结构化克隆复制 JSON 风格工具参数。 */
function cloneInput(
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return structuredClone(input) as Record<string, unknown>;
}

/** 递归冻结普通对象和数组。 */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

/** 将现有路径或“真实祖先 + 尚不存在尾部”解析为物理身份。 */
function resolvePhysicalPath(targetPath: string, basePath = process.cwd()): string {
  let current = isAbsolute(targetPath)
    ? resolve(targetPath)
    : resolve(basePath, targetPath);
  const missingSegments: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    missingSegments.unshift(current.slice(parent.length).replace(/^[\\/]+/, ''));
    current = parent;
  }
  const physicalParent = existsSync(current) ? realpathSync(current) : current;
  return missingSegments.length > 0
    ? resolve(physicalParent, ...missingSegments)
    : physicalParent;
}

/** 使用路径分段比较物理根与候选，避免兄弟前缀和 junction 逃逸。 */
function isPhysicalPathInside(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === ''
    || (!relation.startsWith('..') && !isAbsolute(relation));
}
