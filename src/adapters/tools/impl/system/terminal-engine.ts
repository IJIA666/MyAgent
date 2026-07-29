/**
 * 纯净无状态的进程执行引擎底座。
 * 核心职责：
 * 1. 负责 Node.js 子进程（spawn）的启动与生命周期流控；
 * 2. 实施超时与无输出双重定时器监控，并支持 Windows 进程树递归强杀；
 * 3. 进行大日志防爆溢写（Spilling）截断，以及 Windows npm 漏洞重定向与乱码防御。
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import {
  createCredentialEnvironment,
  createCredentialProfile,
  type CredentialAudience,
} from '../../../../core/domain/security/credential-profile.js';
import { resolve, dirname } from 'path';
import { existsSync, createWriteStream, WriteStream, statSync, openSync, readSync, closeSync } from 'fs';
import { tmpdir } from 'os';
import { TerminalTaskStatus } from './terminal-config.js';
import iconv from 'iconv-lite';
import { getRuntimeEnv } from '../../../../config/env.js';
import { detectAdvisoryWarnings } from './terminal-guard.js';
import type { ShellExecutionPlan, PlatformExecutionOptions } from './terminal-types.js';

// Windows 平台活动代码页（chcp）探测与编码识别
let activeEncoding = 'utf-8';
if (process.platform === 'win32') {
  try {
    const rawChcp = execSync('chcp', { stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf-8');
    const match = rawChcp.match(/\d+/);
    if (match) {
      const codePage = match[0];
      if (codePage === '936') {
        activeEncoding = 'gbk';
      } else if (codePage === '65001') {
        activeEncoding = 'utf-8';
      } else {
        activeEncoding = 'cp' + codePage;
      }
    }
  } catch {
    // 忽略异常，降级为 utf-8
  }
}

/**
 * 任务运行时信息接口
 */
export interface TaskInfo {
  id: string;
  command: string;
  cwd: string;
  status: TerminalTaskStatus;
  exitCode: number | null;
  startTime: number;
  duration: number | null;
  logPath: string;
  headText: string;
  tailText: string;
  /** 可选的任务所属会话唯一 ID，用于生命周期回收 */
  sessionId?: string;
  /** 失败的具体原因（超时/卡死等） */
  failureReason?: 'timeout' | 'stalled' | 'error';
  /** 敏感或逃逸警告信息 */
  advisoryWarnings?: string[];
}

/**
 * 全局后台任务追踪表，键为 Task ID
 */
export const activeTasks = new Map<string, TaskInfo & { child?: ChildProcess }>();

/**
 * 原子地流转任务状态。
 * 如果转换成功，则返回 true，否则返回 false。
 * 
 * @param taskId - 任务唯一 ID
 * @param nextState - 目标流转状态
 * @returns 是否成功流转状态
 */
export function transitionTaskState(taskId: string, nextState: TerminalTaskStatus): boolean {
  const task = activeTasks.get(taskId);
  if (!task) {
    return false;
  }

  const current = task.status;
  if (current === nextState) {
    return true;
  }

  // 终态包括 COMPLETED, FAILED, KILLED，不可往外流转
  const terminalStates: TerminalTaskStatus[] = ['COMPLETED', 'FAILED', 'KILLED'];
  if (terminalStates.includes(current)) {
    return false;
  }

  let allowed = false;
  if (current === 'PENDING') {
    allowed = nextState === 'RUNNING';
  } else if (current === 'RUNNING') {
    allowed = ['STALLED', 'COMPLETED', 'FAILED', 'KILLED'].includes(nextState);
  } else if (current === 'STALLED') {
    allowed = ['RUNNING', 'FAILED', 'KILLED'].includes(nextState);
  }

  if (allowed) {
    task.status = nextState;
    return true;
  }

  return false;
}

/**
 * 剔除字符串中的所有 ANSI 转义和终端控制序列。
 * 
 * @param text - 原始字符串
 * @returns 过滤后的纯净文本
 */
export function stripAnsi(text: string): string {
  const u001b = String.fromCharCode(27);
  const u009b = String.fromCharCode(155);
  const pattern = new RegExp('[' + u001b + u009b + '][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]', 'g');
  return text.replace(pattern, '');
}

/**
 * 强杀整棵子进程树。
 * 优先使用 `platformOptions.killCommand` 模板执行平台特定杀进程命令，其次回退到 `process.kill(pid, 'SIGKILL')`。
 *
 * @param pid - 根进程 PID
 * @param platformOptions - 可选的平台特化选项，包含杀进程命令模板
 * @returns
 */
export function killProcessTree(pid: number, platformOptions?: PlatformExecutionOptions): Promise<void> {
  return new Promise((resolve) => {
    const killCmd = platformOptions?.killCommand;
    if (killCmd && killCmd.length > 0) {
      // 使用 Plan 提供的平台特定杀进程命令模板
      const args = killCmd.map(arg => arg.replace('{pid}', pid.toString()));
      const killer = spawn(args[0], args.slice(1));
      killer.on('close', () => {
        resolve();
      });
      killer.on('error', () => {
        // 降级使用 Node.js 基础杀进程
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // 忽略异常
        }
        resolve();
      });
    } else {
      // POSIX：使用 SIGKILL
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // 忽略异常
      }
      resolve();
    }
  });
}

/**
 * Windows 原生特化：寻找系统 npm/npx 对应的实际 JS 执行脚本
 * @param name 目标指令类型
 * @returns 脚本路径，找不到则返回 null
 */
export function resolveNpmCliPath(name: 'npm' | 'npx'): string | null {
  const nodeDir = dirname(process.execPath);
  const runtimeEnv = getRuntimeEnv();
  const possiblePaths = [
    resolve(nodeDir, 'node_modules/npm/bin', `${name}-cli.js`),
    resolve(nodeDir, 'node_modules/npm/bin', `${name}.js`),
    resolve(runtimeEnv.APPDATA || '', 'npm/node_modules/npm/bin', `${name}-cli.js`)
  ];
  
  for (const p of possiblePaths) {
    if (existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * 命令行分割解析算法（支持带双引号和单引号转义空格）
 * @param cmd 命令行文本
 * @returns 参数数组
 */
export function parseCommandLine(cmd: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';

  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i];
    if ((char === '"' || char === "'") && (i === 0 || cmd[i - 1] !== '\\')) {
      if (inQuotes && char === quoteChar) {
        inQuotes = false;
      } else if (!inQuotes) {
        inQuotes = true;
        quoteChar = char;
      } else {
        current += char;
      }
    } else if (char === ' ' && !inQuotes) {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current) {
    args.push(current);
  }
  return args;
}

/**
 * 格式化任务的返回输出，集成首尾截断和 XML 元数据标签
 * @param taskInfo 任务详情
 * @param totalBytes 输出总字节数
 * @param limit 截断单侧最大长度
 * @returns 格式化的文本结果
 */
export function formatTaskResult(taskInfo: TaskInfo, totalBytes: number, limit: number): string {
  const content = totalBytes <= limit * 2
    ? taskInfo.headText
    : `${taskInfo.headText}\n\n... [此处日志因过长被截断，已忽略中间的 ${totalBytes - taskInfo.headText.length - taskInfo.tailText.length} 字节内容] ...\n\n${taskInfo.tailText}`;

  let warningMeta = '';
  if (taskInfo.advisoryWarnings && taskInfo.advisoryWarnings.length > 0) {
    warningMeta = `\n  <advisory_warnings>\n` + taskInfo.advisoryWarnings.map(w => `    <warning>${w}</warning>`).join('\n') + `\n  </advisory_warnings>`;
  }

  const meta = `\n\n<shell_metadata>\n  <exit_code>${taskInfo.exitCode ?? 'unknown'}</exit_code>\n  <duration_ms>${taskInfo.duration ?? 0}</duration_ms>\n  <log_path>${taskInfo.logPath}</log_path>${warningMeta}\n</shell_metadata>`;
  return content + meta;
}

/**
 * 校验日志中是否存在实质性的错误输出
 * @param text 日志文本
 * @returns 是否包含报错关键字
 */
export function checkHasRealError(text: string): boolean {
  const lowercase = text.toLowerCase();
  const errorKeywords = ['error', 'failed', 'exception', 'fatal', 'invalid', 'cannot', 'permission denied'];
  for (const kw of errorKeywords) {
    if (lowercase.includes(kw)) {
      return true;
    }
  }
  return false;
}

/**
 * 核心进程执行引擎，专注于底座的 spawn 执行与状态生命周期监控。
 * 当传入 `plan` 时，直接消费 Plan 中的 `executable` + `argv` + `platformOptions`，
 * 不再自行解析命令或执行 shell 选择分支。
 *
 * @param command - 要执行的命令行（向后兼容路径，无 Plan 时使用）
 * @param targetCwd - 经过校验清洗的绝对工作目录
 * @param isBackground - 是否显式启动为后台驻留任务
 * @param options - 超时限制选项
 * @param sessionId - 可选的任务所属会话 ID
 * @param plan - 可选的 ShellExecutionPlan；传入后 Engine 直接消费 Plan，不再做 shell 推断
 * @returns 包含执行日志及退出元数据的执行摘要
 */
export async function runCommandEngine(
  command: string,
  targetCwd: string,
  isBackground?: boolean,
  options?: {
    timeoutMs?: number;
    noOutputTimeoutMs?: number;
    watch_patterns?: string[];
    onNotification?: (event: {
      type: 'watch_match' | 'completed' | 'stalled';
      taskId: string;
      pattern?: string;
      output?: string;
    }) => void;
    signal?: AbortSignal;
    /** 已授权 ExecutionPlan 绑定的凭据受众，工具参数不能覆盖。 */
    credentialAudience?: Extract<CredentialAudience, 'terminal' | 'sub-agent'>;
  },
  sessionId?: string,
  plan?: ShellExecutionPlan,
): Promise<string> {
  let exe: string;
  let remainingArgs: string[];

  if (plan) {
    // 新路径：直接消费 Plan，不自行解析或推断 shell
    exe = plan.executable;
    remainingArgs = [...plan.argv];

    // 应用 PowerShell 编码引导（由 Plan 工厂预置）
    if (plan.platformOptions.encodingBootstrap) {
      for (let i = 0; i < remainingArgs.length; i++) {
        if ((remainingArgs[i] === '-Command' || remainingArgs[i] === '-c') && i + 1 < remainingArgs.length) {
          remainingArgs[i + 1] = plan.platformOptions.encodingBootstrap + remainingArgs[i + 1];
          break;
        }
      }
    }
  } else {
    // 向后兼容路径：自行解析命令
    const cmdArgs = parseCommandLine(command);
    if (cmdArgs.length === 0) {
      throw new Error('命令不能为空。');
    }
    exe = cmdArgs[0];
    remainingArgs = cmdArgs.slice(1);

    // Windows npm/npx 漏洞修复重定向（防止 shell: false 时无法调用 .cmd 脚本）
    if (process.platform === 'win32') {
      const lowerExe = exe.toLowerCase();
      if (lowerExe === 'npm' || lowerExe === 'npx') {
        const cliPath = resolveNpmCliPath(lowerExe as 'npm' | 'npx');
        if (cliPath) {
          remainingArgs.unshift(cliPath);
          exe = process.execPath;
        }
      }
    }

    // Windows 乱码防御：当目标为 powershell 时注入输出编码重设逻辑
    if (process.platform === 'win32') {
      const lowerExe = exe.toLowerCase();
      if (lowerExe === 'powershell' || lowerExe === 'powershell.exe') {
        for (let i = 0; i < remainingArgs.length; i++) {
          if ((remainingArgs[i] === '-Command' || remainingArgs[i] === '-c') && i + 1 < remainingArgs.length) {
            remainingArgs[i + 1] = `try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}; ${remainingArgs[i + 1]}`;
            break;
          }
        }
      }
    }
  }

  // 准备流式防爆记录（Disk Spilling）与临时日志输出文件
  const taskId = 'task_' + Math.random().toString(36).substring(2, 10);
  const logFileName = `agent-terminal-${taskId}-${Date.now()}.log`;
  const tempLogPath = resolve(tmpdir(), logFileName);
  const logStream = createWriteStream(tempLogPath);

  const startTime = Date.now();
  const timeoutMs = options?.timeoutMs ?? 60000;
  const noOutputTimeoutMs = options?.noOutputTimeoutMs ?? 30000;
  const watch_patterns = options?.watch_patterns ?? [];

  // 内存头部与尾部 Chunk 字节存储限制（默认单向 50KB，共计 100KB 限制）
  const MAX_MEMORY_BYTES = 50 * 1024;
  const headChunks: unknown[] = [];
  let headBytes = 0;
  let headText = '';
  const tailChunks: unknown[] = [];
  let tailBytes = 0;
  let totalBytes = 0;

  // Watcher 行级匹配、频控与断路器上下文变量
  let lastMatchTime = 0;
  let matchStrikeCount = 0;
  let circuitBroken = false;
  let lineRemainder = '';

  // 接收事件监听并分发写入
  const handleData = (chunk: Buffer) => {
    totalBytes += chunk.length;
    logStream.write(chunk);

    // 收集头部预览字节，若满 50KB 立即进行物理释放
    if (headBytes < MAX_MEMORY_BYTES) {
      const needed = MAX_MEMORY_BYTES - headBytes;
      if (chunk.length <= needed) {
        headChunks.push(chunk);
        headBytes += chunk.length;
      } else {
        headChunks.push(chunk.subarray(0, needed));
        headBytes += needed;
      }
      if (headBytes >= MAX_MEMORY_BYTES) {
        const headCombined = Buffer.concat(headChunks as Uint8Array[]);
        headText = iconv.decode(headCombined, activeEncoding);
        headChunks.length = 0; // 释放引用以规避 GC 大对象积压
      }
    }

    // 收集尾部预览双端队列 (Deque)
    tailChunks.push(chunk);
    tailBytes += chunk.length;
    while (tailChunks.length > 0 && tailBytes - (tailChunks[0] as Uint8Array).length >= MAX_MEMORY_BYTES) {
      const removed = tailChunks.shift();
      if (removed) {
        tailBytes -= (removed as Uint8Array).length;
      }
    }

    const text = iconv.decode(chunk, activeEncoding);

    // 实施 watch_patterns 匹配、频控与断路器
    if (watch_patterns.length > 0 && !circuitBroken) {
      const lines = (lineRemainder + text).split(/\r?\n/);
      lineRemainder = lines.pop() || '';
      for (const line of lines) {
        if (circuitBroken) break;
        for (const pattern of watch_patterns) {
          if (line.includes(pattern)) {
            const now = Date.now();
            if (now - lastMatchTime < 15000) {
              matchStrikeCount++;
              if (matchStrikeCount >= 3) {
                circuitBroken = true;
                const warningMsg = `\n[系统警告] 任务 ${taskId} 命中的匹配词 "${pattern}" 发生高频刷屏，已自动断开 Watcher 熔断器，退化为仅在退出时通知。\n`;
                process.stdout.write(warningMsg);
                if (options?.onNotification) {
                  options.onNotification({
                    type: 'watch_match',
                    taskId,
                    pattern,
                    output: 'CIRCUIT_BREAKER_TRIGGERED'
                  });
                }
              }
            } else {
              lastMatchTime = now;
              matchStrikeCount = 0;
              const matchMsg = `\n[匹配提醒] 任务 ${taskId} 命中匹配词 "${pattern}"，输出内容：${line}\n`;
              process.stdout.write(matchMsg);
              if (options?.onNotification) {
                options.onNotification({
                  type: 'watch_match',
                  taskId,
                  pattern,
                  output: line
                });
              }
            }
            break;
          }
        }
      }
    }
  };

  // 执行子进程的 spawn
  const child = spawn(exe, remainingArgs, {
    cwd: targetCwd,
    env: {
      ...createCredentialEnvironment(
        createCredentialProfile(options?.credentialAudience ?? 'terminal'),
        getRuntimeEnv(),
      ),
    },
    shell: false
  });

  const advisoryWarnings = detectAdvisoryWarnings(command, plan?.shellKind);

  const taskInfo: TaskInfo & { child?: ChildProcess; logStream?: WriteStream } = {
    id: taskId,
    command,
    cwd: targetCwd,
    status: 'PENDING',
    exitCode: null,
    startTime,
    duration: null,
    logPath: tempLogPath,
    headText: '',
    tailText: '',
    child,
    logStream,
    sessionId,
    advisoryWarnings
  };
  activeTasks.set(taskId, taskInfo);

  // 监听并透传 AbortSignal 物理强杀子进程树
  if (options?.signal) {
    if (options.signal.aborted) {
      if (transitionTaskState(taskId, 'FAILED')) {
        taskInfo.failureReason = 'timeout';
        if (child.pid) {
          killProcessTree(child.pid, plan?.platformOptions).then(() => cleanup());
        } else {
          cleanup();
        }
      }
    }
    options.signal.addEventListener('abort', () => {
      if (transitionTaskState(taskId, 'FAILED')) {
        taskInfo.failureReason = 'timeout';
        if (child.pid) {
          killProcessTree(child.pid, plan?.platformOptions).then(() => cleanup());
        } else {
          cleanup();
        }
      }
    });
  }

  // 启动后立即流转状态为 RUNNING
  transitionTaskState(taskId, 'RUNNING');

  // 定时器变量声明
  let overallTimeoutTimer: NodeJS.Timeout | null = null;
  let inactivityTimer: NodeJS.Timeout | null = null;
  let absoluteTimeoutTimer: NodeJS.Timeout | null = null;
  let stallWatchdogInterval: NodeJS.Timeout | null = null;

  // 清除全部正在工作的定时器
  const clearTimers = () => {
    if (overallTimeoutTimer) {
      clearTimeout(overallTimeoutTimer);
      overallTimeoutTimer = null;
    }
    if (inactivityTimer) {
      clearTimeout(inactivityTimer);
      inactivityTimer = null;
    }
    if (absoluteTimeoutTimer) {
      clearTimeout(absoluteTimeoutTimer);
      absoluteTimeoutTimer = null;
    }
    if (stallWatchdogInterval) {
      clearInterval(stallWatchdogInterval);
      stallWatchdogInterval = null;
    }
  };

  // 重设无输出超时时限
  const resetInactivityTimer = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      if (transitionTaskState(taskId, 'FAILED')) {
        taskInfo.failureReason = 'timeout';
        killProcessTree(child.pid!, plan?.platformOptions).then(() => {
          cleanup();
        });
      }
    }, noOutputTimeoutMs);
  };

  // 5秒大小监控与 looksLikePrompt 匹配看守器
  let lastSize = 0;
  let noGrowthSeconds = 0;

  const startStallWatchdog = () => {
    stallWatchdogInterval = setInterval(() => {
      if (taskInfo.status !== 'RUNNING') {
        return;
      }
      try {
        if (!existsSync(tempLogPath)) return;
        const stats = statSync(tempLogPath);
        const currentSize = stats.size;
        
        if (currentSize === lastSize) {
          noGrowthSeconds += 5;
        } else {
          noGrowthSeconds = 0;
          lastSize = currentSize;
        }

        if (noGrowthSeconds >= 30) {
          // 从尾部读取 1024 字节进行解码和清洗
          const fd = openSync(tempLogPath, 'r');
          const buffer = Buffer.alloc(1024);
          const readLength = Math.min(1024, currentSize);
          const position = Math.max(0, currentSize - readLength);
          
          readSync(fd, buffer as unknown as Uint8Array, 0, readLength, position);
          closeSync(fd);

          const tailSlice = buffer.subarray(0, readLength);
          const decodedTail = iconv.decode(tailSlice, activeEncoding);
          const purifiedTail = stripAnsi(decodedTail);

          const looksLikePrompt = /(y\/n)|continue\?|overwrite\?|按任意键继续|是否确定/i;
          if (looksLikePrompt.test(purifiedTail)) {
            noGrowthSeconds = 0;
            if (transitionTaskState(taskId, 'STALLED')) {
              taskInfo.failureReason = 'stalled';
              
              const noticeMsg = `\n[卡死警告] 任务 ${taskId} 在 30 秒内日志无增长，且检测到交互提示符，已自动强杀进程！\n`;
              process.stdout.write(noticeMsg);
              if (options?.onNotification) {
                options.onNotification({
                  type: 'stalled',
                  taskId,
                  output: purifiedTail
                });
              }

              killProcessTree(child.pid!, plan?.platformOptions).then(() => {
                transitionTaskState(taskId, 'FAILED');
                cleanup();
              });
            }
          } else {
            // 未命中交互提示符，回退 5 秒以进行下一次周期的滑动检测
            noGrowthSeconds = 25;
          }
        }
      } catch {
        // 忽略文件读取异常
      }
    }, 5000);
  };

  // 启动看守器
  startStallWatchdog();

  // 挂载数据监听
  child.stdout.on('data', (chunk: Buffer) => {
    handleData(chunk);
    resetInactivityTimer();
  });

  child.stderr.on('data', (chunk: Buffer) => {
    handleData(chunk);
    resetInactivityTimer();
  });

  // 挂载清理退出动作
  let resolved = false;
  let cleanupStarted = false;
  let shouldNotifyCompletion = false;
  let resolvePromise: (value: string) => void;

  const promise = new Promise<string>((res) => {
    resolvePromise = res;
  });

  function cleanup() {
    // close、超时和强杀回调可能同时到达；清理与完成通知必须保持单次语义。
    if (cleanupStarted) {
      return;
    }
    cleanupStarted = true;
    clearTimers();
    logStream.end();

    taskInfo.duration = Date.now() - startTime;

    // 惰性拼接并转码头尾预览 buffer 块
    if (headChunks.length > 0) {
      const headCombined = Buffer.concat(headChunks as Uint8Array[]);
      taskInfo.headText = iconv.decode(headCombined, activeEncoding);
      headChunks.length = 0;
    } else {
      taskInfo.headText = headText;
    }

    const tailCombined = Buffer.concat(tailChunks as Uint8Array[]);
    const sliceStart = Math.max(0, tailCombined.length - MAX_MEMORY_BYTES);
    const finalTailBuffer = tailCombined.subarray(sliceStart);
    taskInfo.tailText = iconv.decode(finalTailBuffer, activeEncoding);

    // 原子化流转至终态
    if (taskInfo.status === 'RUNNING' || taskInfo.status === 'STALLED') {
      const finalState = taskInfo.exitCode === 0 ? 'COMPLETED' : 'FAILED';
      transitionTaskState(taskId, finalState);
    }

    if (shouldNotifyCompletion && (taskInfo.status === 'COMPLETED' || taskInfo.status === 'FAILED')) {
      if (options?.onNotification) {
        options.onNotification({
          type: 'completed',
          taskId,
          output: `Exit Code: ${taskInfo.exitCode}, Status: ${taskInfo.status}`
        });
      }
    }

    if (resolved) return;
    resolved = true;

    const output = formatTaskResult(taskInfo, totalBytes, MAX_MEMORY_BYTES);
    
    if (taskInfo.status === 'COMPLETED') {
      resolvePromise(output);
    } else {
      if (taskInfo.failureReason === 'timeout') {
        resolvePromise(`[错误] 命令执行超时（总限制: ${timeoutMs}ms 或无输出限制: ${noOutputTimeoutMs}ms 或 30分钟绝对超时限制）。\n${output}`);
      } else {
        // 命令退避策略校验
        const hasRealError = checkHasRealError(taskInfo.tailText);
        if (taskInfo.exitCode === 1 && !hasRealError) {
          resolvePromise(`[提示] 命令以退出码 1 结束，但未检测到实质性错误输出。\n${output}`);
        } else {
          resolvePromise(`[错误] 命令执行失败，退出码为 ${taskInfo.exitCode}。\n${output}`);
        }
      }
    }
  }

  // 绑定子进程事件
  overallTimeoutTimer = setTimeout(() => {
    if (transitionTaskState(taskId, 'FAILED')) {
      taskInfo.failureReason = 'timeout';
      killProcessTree(child.pid!, plan?.platformOptions).then(() => {
        cleanup();
      });
    }
  }, timeoutMs);

  // 30 分钟无条件绝对超时门禁，防范交互卡死
  const ABSOLUTE_TIMEOUT_MS = 30 * 60 * 1000;
  absoluteTimeoutTimer = setTimeout(() => {
    if (transitionTaskState(taskId, 'FAILED')) {
      taskInfo.failureReason = 'timeout';
      killProcessTree(child.pid!, plan?.platformOptions).then(() => {
        cleanup();
      });
    }
  }, ABSOLUTE_TIMEOUT_MS);

  resetInactivityTimer();

  child.on('exit', (code) => {
    taskInfo.exitCode = code;
  });

  child.on('close', () => {
    const finalState = taskInfo.exitCode === 0 ? 'COMPLETED' : 'FAILED';
    if (transitionTaskState(taskId, finalState)) {
      cleanup();
    }
  });

  child.on('error', (err) => {
    if (transitionTaskState(taskId, 'FAILED')) {
      taskInfo.failureReason = 'error';
      handleData(Buffer.from(`启动子进程时发生错误: ${err.message}\n`, 'utf-8'));
      cleanup();
    }
  });

  // 后台执行缓冲及自动阻塞降级
  if (isBackground) {
    // 200ms 的启动观察缓冲期
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Windows 下 close 事件可能晚于 exit 事件到达；已有退出码说明进程已结束，
    // 此时继续等待 promise 完成清理，不能误报为“存活超过 200ms”。
    if (
      taskInfo.status === 'FAILED' ||
      taskInfo.status === 'COMPLETED' ||
      taskInfo.status === 'KILLED' ||
      taskInfo.exitCode !== null
    ) {
      return promise;
    } else {
      resolved = true;
      shouldNotifyCompletion = true;
      // 在后台继续允许超时及自动杀逻辑，但不阻断同步返回
      return `[系统提示] 任务已在后台成功启动并存活超过 200ms，Task ID: ${taskId}。完整日志将流式写入 ${tempLogPath}。`;
    }
  }

  // 自动阻塞降级 (Auto-Backgrounding)：同步执行若超 15s 则转为后台
  const AUTO_BACKGROUND_MS = 15000;
  const bgTimer = setTimeout(() => {
    if (!resolved) {
      resolved = true;
      shouldNotifyCompletion = true;
      resolvePromise(`[系统提示] 命令已运行超过 15 秒尚未结束，已被自动转入后台托管，Task ID 为 ${taskId}。完整日志路径: ${tempLogPath}`);
    }
  }, AUTO_BACKGROUND_MS);

  return promise.finally(() => {
    clearTimeout(bgTimer);
  });
}

/**
 * 批量中止属于特定会话的全部活动后台子进程与任务。
 *
 * @param sessionId - 会话唯一标识 ID
 */
export async function abortSessionTasks(sessionId: string): Promise<void> {
  const killPromises: Promise<void>[] = [];
  for (const [taskId, task] of activeTasks.entries()) {
    if (task.sessionId === sessionId && (task.status === 'RUNNING' || task.status === 'STALLED')) {
      if (transitionTaskState(taskId, 'FAILED')) {
        task.failureReason = 'error';
        if (task.child && typeof task.child.pid === 'number') {
          // 会话级中止不持有 Plan，使用 process.kill 降级路径
          killPromises.push(killProcessTree(task.child.pid));
        }
        activeTasks.delete(taskId);
      }
    }
  }
  await Promise.all(killPromises);
}
