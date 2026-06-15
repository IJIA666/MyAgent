/**
 * 纯净无状态的进程执行引擎底座。
 * 核心职责：
 * 1. 负责 Node.js 子进程（spawn）的启动与生命周期流控；
 * 2. 实施超时与无输出双重定时器监控，并支持 Windows 进程树递归强杀；
 * 3. 进行大日志防爆溢写（Spilling）截断，以及 Windows npm 漏洞重定向与乱码防御。
 */

import { spawn, ChildProcess } from 'child_process';
import { resolve, dirname } from 'path';
import { existsSync, createWriteStream, WriteStream } from 'fs';
import { tmpdir } from 'os';

/**
 * 任务运行时信息接口
 */
export interface TaskInfo {
  id: string;
  command: string;
  cwd: string;
  status: 'running' | 'success' | 'failed' | 'timeout';
  exitCode: number | null;
  startTime: number;
  duration: number | null;
  logPath: string;
  headText: string;
  tailText: string;
}

/**
 * 全局后台任务追踪表，键为 Task ID
 */
export const activeTasks = new Map<string, TaskInfo & { child?: ChildProcess }>();

/**
 * Windows 原生特化：强杀整棵子进程树
 * @param pid 根进程 PID
 * @returns
 */
export function killProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      // 强制使用 taskkill 递归切除子进程树
      const taskkill = spawn('taskkill', ['/PID', pid.toString(), '/T', '/F']);
      taskkill.on('close', () => {
        resolve();
      });
      taskkill.on('error', () => {
        // 降级使用 Node.js 基础杀进程
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // 忽略异常
        }
        resolve();
      });
    } else {
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
  const possiblePaths = [
    resolve(nodeDir, 'node_modules/npm/bin', `${name}-cli.js`),
    resolve(nodeDir, 'node_modules/npm/bin', `${name}.js`),
    resolve(process.env.APPDATA || '', 'npm/node_modules/npm/bin', `${name}-cli.js`)
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

  const meta = `\n\n<shell_metadata>\n  <exit_code>${taskInfo.exitCode ?? 'unknown'}</exit_code>\n  <duration_ms>${taskInfo.duration ?? 0}</duration_ms>\n  <log_path>${taskInfo.logPath}</log_path>\n</shell_metadata>`;
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
 * 核心进程执行引擎，专注于底座的 spawn 执行与状态生命周期监控
 * @param command 要执行的命令行
 * @param targetCwd 经过校验清洗的绝对工作目录
 * @param isBackground 是否显式启动为后台驻留任务
 * @param options 超时限制选项
 * @returns 包含执行日志及退出元数据的执行摘要
 */
export async function runCommandEngine(
  command: string,
  targetCwd: string,
  isBackground?: boolean,
  options?: { timeoutMs?: number; noOutputTimeoutMs?: number }
): Promise<string> {
  // 解析命令行程序与参数
  const cmdArgs = parseCommandLine(command);
  if (cmdArgs.length === 0) {
    throw new Error('命令不能为空。');
  }

  let exe = cmdArgs[0];
  const remainingArgs = cmdArgs.slice(1);

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

  // 准备流式防爆记录（Disk Spilling）与临时日志输出文件
  const taskId = 'task_' + Math.random().toString(36).substring(2, 10);
  const logFileName = `agent-terminal-${taskId}-${Date.now()}.log`;
  const tempLogPath = resolve(tmpdir(), logFileName);
  const logStream = createWriteStream(tempLogPath);

  const startTime = Date.now();
  const timeoutMs = options?.timeoutMs ?? 60000;
  const noOutputTimeoutMs = options?.noOutputTimeoutMs ?? 30000;

  // 内存头部与尾部 Chunk 字节存储限制（默认单向 50KB，共计 100KB 限制）
  const MAX_MEMORY_BYTES = 50 * 1024;
  let headBuffer = '';
  let tailBuffer = '';
  let totalBytes = 0;

  // 接收事件监听并分发写入
  const handleData = (chunk: Buffer) => {
    totalBytes += chunk.length;
    logStream.write(chunk);

    const text = chunk.toString('utf-8');
    if (headBuffer.length < MAX_MEMORY_BYTES) {
      const remainingSpace = MAX_MEMORY_BYTES - headBuffer.length;
      headBuffer += text.substring(0, remainingSpace);
    }
    
    tailBuffer += text;
    if (tailBuffer.length > MAX_MEMORY_BYTES) {
      tailBuffer = tailBuffer.substring(tailBuffer.length - MAX_MEMORY_BYTES);
    }
  };

  // 执行子进程的 spawn
  const child = spawn(exe, remainingArgs, {
    cwd: targetCwd,
    env: { ...process.env },
    shell: false
  });

  const taskInfo: TaskInfo & { child?: ChildProcess; logStream?: WriteStream } = {
    id: taskId,
    command,
    cwd: targetCwd,
    status: 'running',
    exitCode: null,
    startTime,
    duration: null,
    logPath: tempLogPath,
    headText: '',
    tailText: '',
    child,
    logStream
  };
  activeTasks.set(taskId, taskInfo);

  // 定时器变量声明
  let overallTimeoutTimer: NodeJS.Timeout | null = null;
  let inactivityTimer: NodeJS.Timeout | null = null;

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
  };

  // 重设无输出超时时限
  const resetInactivityTimer = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      taskInfo.status = 'timeout';
      killProcessTree(child.pid!).then(() => {
        cleanup();
      });
    }, noOutputTimeoutMs);
  };

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
  let resolvePromise: (value: string) => void;

  const promise = new Promise<string>((res) => {
    resolvePromise = res;
  });

  const cleanup = () => {
    clearTimers();
    logStream.end();

    taskInfo.duration = Date.now() - startTime;
    taskInfo.headText = headBuffer;
    taskInfo.tailText = tailBuffer;

    if (taskInfo.status === 'running') {
      if (taskInfo.exitCode === 0) {
        taskInfo.status = 'success';
      } else {
        taskInfo.status = 'failed';
      }
    }

    if (resolved) return;
    resolved = true;

    const output = formatTaskResult(taskInfo, totalBytes, MAX_MEMORY_BYTES);
    
    if (taskInfo.status === 'success') {
      resolvePromise(output);
    } else {
      if (taskInfo.status === 'timeout') {
        resolvePromise(`[错误] 命令执行超时（总限制: ${timeoutMs}ms 或无输出限制: ${noOutputTimeoutMs}ms）。\n${output}`);
      } else {
        // 命令退避策略校验
        const hasRealError = checkHasRealError(tailBuffer);
        if (taskInfo.exitCode === 1 && !hasRealError) {
          resolvePromise(`[提示] 命令以退出码 1 结束，但未检测到实质性错误输出。\n${output}`);
        } else {
          resolvePromise(`[错误] 命令执行失败，退出码为 ${taskInfo.exitCode}。\n${output}`);
        }
      }
    }
  };

  // 绑定子进程事件
  overallTimeoutTimer = setTimeout(() => {
    taskInfo.status = 'timeout';
    killProcessTree(child.pid!).then(() => {
      cleanup();
    });
  }, timeoutMs);

  resetInactivityTimer();

  child.on('exit', (code) => {
    taskInfo.exitCode = code;
  });

  child.on('close', () => {
    cleanup();
  });

  child.on('error', (err) => {
    taskInfo.status = 'failed';
    handleData(Buffer.from(`启动子进程时发生错误: ${err.message}\n`, 'utf-8'));
    cleanup();
  });

  // 后台执行缓冲及自动阻塞降级
  if (isBackground) {
    // 200ms 的启动观察缓冲期
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (taskInfo.status === 'failed') {
      cleanup();
      return promise;
    } else {
      resolved = true;
      // 在后台继续允许超时及自动杀逻辑，但不阻断同步返回
      return `[系统提示] 任务已在后台成功启动并存活超过 200ms，Task ID: ${taskId}。完整日志将流式写入 ${tempLogPath}。`;
    }
  }

  // 自动阻塞降级 (Auto-Backgrounding)：同步执行若超 15s 则转为后台
  const AUTO_BACKGROUND_MS = 15000;
  const bgTimer = setTimeout(() => {
    if (!resolved) {
      resolved = true;
      resolvePromise(`[系统提示] 命令已运行超过 15 秒尚未结束，已被自动转入后台托管，Task ID 为 ${taskId}。完整日志路径: ${tempLogPath}`);
    }
  }, AUTO_BACKGROUND_MS);

  return promise.finally(() => {
    clearTimeout(bgTimer);
  });
}
