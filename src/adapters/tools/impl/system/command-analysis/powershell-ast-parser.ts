/**
 * PowerShell 原生 AST 解析适配器。
 * 通过受限子进程调用 System.Management.Automation.Language.Parser，并提供超时、输出上限和 LRU 缓存。
 */

import { spawn } from 'child_process';
import { resolveShellLauncher } from '../terminal-plan.js';
import type {
  CommandRedirectionAnalysis,
  CommandRiskSignal,
  ShellCommandSyntaxNode,
  ShellStructureParseResult,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 1_500;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_CACHE_SIZE = 100;
const POWERSHELL_AST_SCRIPT = `
$source = [Console]::In.ReadToEnd()
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
$commands = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object {
  $node = $_
  $parent = $node.Parent
  while ($null -ne $parent -and -not ($parent -is [System.Management.Automation.Language.CommandAst])) {
    $parent = $parent.Parent
  }
  @{
    text = $node.Extent.Text
    start = $node.Extent.StartOffset
    end = $node.Extent.EndOffset
    parentStart = if ($null -ne $parent) { $parent.Extent.StartOffset } else { $null }
    redirections = @($node.Redirections | ForEach-Object { $_.Extent.Text })
  }
})
@{
  errors = @($errors | ForEach-Object { $_.Message })
  nodes = $commands
} | ConvertTo-Json -Depth 6 -Compress
`;

/** PowerShell 解析 runner 的资源限制。 */
export interface PowerShellParserLimits {
  /** 单次解析最大耗时。 */
  readonly timeoutMs: number;
  /** 标准输出允许的最大字节数。 */
  readonly maxOutputBytes: number;
}

/** 可注入的 PowerShell 解析进程 runner。 */
export type PowerShellParserRunner = (
  command: string,
  limits: Readonly<PowerShellParserLimits>,
) => Promise<string>;

/** PowerShell AST 解析器构造参数。 */
export interface PowerShellAstParserOptions {
  /** 单次解析超时，默认 1500 毫秒。 */
  readonly timeoutMs?: number;
  /** 标准输出上限，默认 256 KiB。 */
  readonly maxOutputBytes?: number;
  /** LRU 缓存容量，默认 100。 */
  readonly cacheSize?: number;
  /** 测试或替代运行环境使用的解析 runner。 */
  readonly runner?: PowerShellParserRunner;
}

interface RawPowerShellNode {
  readonly text?: unknown;
  readonly start?: unknown;
  readonly end?: unknown;
  readonly parentStart?: unknown;
  readonly redirections?: unknown;
}

interface RawPowerShellParseResult {
  readonly errors?: unknown;
  readonly nodes?: unknown;
}

/** 带稳定风险代码的 PowerShell 解析器内部错误。 */
class PowerShellParserError extends Error {
  /** 稳定风险代码。 */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PowerShellParserError';
    this.code = code;
  }
}

/** 将 PowerShell 重定向文本投影为保守证据。 */
function parseRedirection(text: string): CommandRedirectionAnalysis {
  const match = text.trim().match(/^(\d*[*]?)(>>|>|<)\s*(.*)$/);
  const operator = match?.[2] ?? text.trim();
  const target = match?.[3]?.trim() || undefined;
  const isInput = operator === '<';
  return {
    operator,
    target,
    sideEffect: isInput ? 'sensitive-read' : 'write',
    permission: 'ask',
    reason: target ? `检测到重定向 ${operator} ${target}` : `重定向 ${operator} 缺少静态目标`,
  };
}

/** 运行受限 PowerShell 子进程并返回 JSON 文本。 */
function runNativePowerShellParser(
  command: string,
  limits: Readonly<PowerShellParserLimits>,
): Promise<string> {
  const launcher = resolveShellLauncher('powershell');
  if (!launcher) {
    return Promise.reject(new PowerShellParserError('parser.powershell-unavailable', '当前平台未找到 PowerShell 解析器'));
  }

  return new Promise<string>((resolve, reject) => {
    const child = spawn(launcher.executable, [...launcher.argsPrefix, POWERSHELL_AST_SCRIPT], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    /** 仅完成一次 Promise，并清理超时计时器。 */
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback();
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new PowerShellParserError('parser.powershell-timeout', 'PowerShell AST 解析超时')));
    }, limits.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > limits.maxOutputBytes) {
        child.kill();
        finish(() => reject(new PowerShellParserError('parser.powershell-output-limit', 'PowerShell AST 输出超过安全上限')));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.reduce((size, item) => size + item.length, 0) < limits.maxOutputBytes) {
        stderr.push(chunk);
      }
    });
    child.on('error', error => {
      finish(() => reject(new PowerShellParserError('parser.powershell-process', error.message)));
    });
    child.on('close', code => {
      finish(() => {
        if (code !== 0) {
          const detail = Buffer.concat(stderr).toString('utf8').trim();
          reject(new PowerShellParserError('parser.powershell-process', detail || `PowerShell 解析进程退出码 ${code}`));
          return;
        }
        resolve(Buffer.concat(stdout).toString('utf8'));
      });
    });
    child.stdin.end(command, 'utf8');
  });
}

/** 将未知 JSON 字段归一化为数组。 */
function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  return value === undefined || value === null ? [] : [value];
}

/** 为可注入 runner 添加可清理的统一超时边界。 */
function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new PowerShellParserError('parser.powershell-timeout', 'PowerShell AST 解析超时'));
    }, timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 带资源限制和 LRU 的 PowerShell AST 解析器。
 */
export class PowerShellAstParser {
  private readonly limits: Readonly<PowerShellParserLimits>;
  private readonly cacheSize: number;
  private readonly runner: PowerShellParserRunner;
  private readonly cache = new Map<string, Promise<ShellStructureParseResult>>();

  /**
   * 创建 PowerShell AST 解析器。
   *
   * @param options - 超时、输出、缓存与 runner 配置
   */
  constructor(options: PowerShellAstParserOptions = {}) {
    this.limits = Object.freeze({
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    });
    this.cacheSize = Math.max(1, options.cacheSize ?? DEFAULT_CACHE_SIZE);
    this.runner = options.runner ?? runNativePowerShellParser;
  }

  /**
   * 解析 PowerShell 命令，并复用相同文本的并发或历史结果。
   *
   * @param command - 原始 PowerShell 命令文本
   * @returns 结构化 AST 节点与解析风险
   */
  parse(command: string): Promise<ShellStructureParseResult> {
    const cached = this.cache.get(command);
    if (cached) {
      // Map 的删除再插入表示最近使用，形成稳定 LRU 顺序。
      this.cache.delete(command);
      this.cache.set(command, cached);
      return cached;
    }

    const pending = this.parseUncached(command);
    this.cache.set(command, pending);
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.cache.delete(oldest);
    }
    return pending;
  }

  /** 执行一次未缓存解析并将异常转换为保守结果。 */
  private async parseUncached(command: string): Promise<ShellStructureParseResult> {
    try {
      const rawText = await runWithTimeout(this.runner(command, this.limits), this.limits.timeoutMs);
      if (Buffer.byteLength(rawText, 'utf8') > this.limits.maxOutputBytes) {
        throw new PowerShellParserError('parser.powershell-output-limit', 'PowerShell AST 输出超过安全上限');
      }
      return this.normalize(rawText);
    } catch (error) {
      const code = error instanceof PowerShellParserError ? error.code : 'parser.powershell-failed';
      const reason = error instanceof Error ? error.message : 'PowerShell AST 解析失败';
      return { parseStatus: 'unsupported', nodes: [], riskSignals: [{ code, reason }] };
    }
  }

  /** 将 PowerShell JSON 输出规范化为稳定领域契约。 */
  private normalize(rawText: string): ShellStructureParseResult {
    let parsed: RawPowerShellParseResult;
    try {
      parsed = JSON.parse(rawText) as RawPowerShellParseResult;
    } catch {
      throw new PowerShellParserError('parser.powershell-json', 'PowerShell AST 返回了无效 JSON');
    }

    const errors = toArray(parsed.errors).filter((item): item is string => typeof item === 'string');
    if (errors.length > 0) {
      return {
        parseStatus: 'invalid',
        nodes: [],
        riskSignals: errors.map((reason): CommandRiskSignal => ({ code: 'parser.powershell-invalid', reason })),
      };
    }

    const rawNodes = toArray(parsed.nodes).filter((item): item is RawPowerShellNode => typeof item === 'object' && item !== null);
    const pathByStart = new Map<number, readonly number[]>();
    const childCounts = new Map<number, number>();
    let rootIndex = 0;
    const nodes: ShellCommandSyntaxNode[] = [];
    for (const rawNode of rawNodes) {
      if (typeof rawNode.text !== 'string' || typeof rawNode.start !== 'number') {
        continue;
      }
      const parentStart = typeof rawNode.parentStart === 'number' ? rawNode.parentStart : undefined;
      const parentPath = parentStart === undefined ? undefined : pathByStart.get(parentStart);
      const childIndex = parentStart === undefined ? rootIndex++ : (childCounts.get(parentStart) ?? 0);
      if (parentStart !== undefined) {
        childCounts.set(parentStart, childIndex + 1);
      }
      const nodePath = parentPath ? [...parentPath, childIndex] : [childIndex];
      pathByStart.set(rawNode.start, nodePath);
      nodes.push({
        command: rawNode.text,
        nodePath,
        redirections: toArray(rawNode.redirections)
          .filter((item): item is string => typeof item === 'string')
          .map(parseRedirection),
      });
    }
    return { parseStatus: 'parsed', nodes, riskSignals: [] };
  }
}

/** 默认 PowerShell AST 解析器单例。 */
export const powershellAstParser = new PowerShellAstParser();
