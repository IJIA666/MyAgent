import { spawn, ChildProcess } from 'child_process';
import { resolve, dirname, sep } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, createWriteStream, WriteStream } from 'fs';
import { tmpdir } from 'os';
import readline from 'readline';
import { getAuthorizedDir } from './base.js';

/**
 * 终端执行工作模式定义
 * Safe: 每次执行命令都必须人工确认
 * Auto: 匹配白名单则自动放行，否则人工确认
 * YOLO: 全部命令直接放行，无视安全风险
 */
export type WorkMode = 'Safe' | 'Auto' | 'YOLO';

/**
 * 全局状态管理接口
 */
interface GlobalState {
  workMode: WorkMode;
}

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
 * 全局工作模式及状态管理（默认 Auto 模式）
 */
const globalState: GlobalState = {
  workMode: 'Auto'
};

/**
 * 全局后台任务追踪表，键为 Task ID
 */
export const activeTasks = new Map<string, TaskInfo & { child?: ChildProcess }>();

/**
 * 获取当前全局安全模式
 * @returns 工作模式
 */
export function getWorkMode(): WorkMode {
  return globalState.workMode;
}

/**
 * 设置当前全局安全模式
 * @param mode 工作模式
 */
export function setWorkMode(mode: WorkMode): void {
  globalState.workMode = mode;
}

/**
 * 获取白名单配置文件绝对路径
 * @returns 配置文件绝对路径
 */
function getAllowedCommandsPath(): string {
  const rootDir = getAuthorizedDir();
  if (!rootDir) {
    return resolve('.agent/allowed_commands.json');
  }
  return resolve(rootDir, '.agent/allowed_commands.json');
}

/**
 * 获取代理工作模式配置绝对路径
 * @returns 配置路径
 */
function getAgentConfigPath(): string {
  const rootDir = getAuthorizedDir();
  if (!rootDir) {
    return resolve('.agent/config.json');
  }
  return resolve(rootDir, '.agent/config.json');
}

/**
 * 读取白名单配置
 * @returns 白名单规则列表
 */
export function loadAllowedCommands(): string[] {
  try {
    const path = getAllowedCommandsPath();
    if (existsSync(path)) {
      const data = readFileSync(path, 'utf-8');
      return JSON.parse(data) as string[];
    }
  } catch {
    // 忽略读取错误，返回空数组
  }
  return [];
}

/**
 * 写入白名单配置
 * @param commands 白名单规则列表
 */
export function saveAllowedCommands(commands: string[]): void {
  try {
    const path = getAllowedCommandsPath();
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path, JSON.stringify(commands, null, 2), 'utf-8');
  } catch (err) {
    console.error(`保存允许的命令白名单失败:`, err);
  }
}

/**
 * 读取当前工作区保存的工作模式
 * @returns 工作模式
 */
export function loadWorkMode(): WorkMode {
  try {
    const configPath = getAgentConfigPath();
    if (existsSync(configPath)) {
      const data = readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(data);
      if (parsed.workMode === 'Safe' || parsed.workMode === 'Auto' || parsed.workMode === 'YOLO') {
        globalState.workMode = parsed.workMode as WorkMode;
        return globalState.workMode;
      }
    }
  } catch {
    // 忽略读取错误
  }
  const envMode = process.env.AGENT_WORK_MODE;
  if (envMode === 'Safe' || envMode === 'Auto' || envMode === 'YOLO') {
    globalState.workMode = envMode;
  }
  return globalState.workMode;
}

/**
 * 保存并设置当前工作模式
 * @param mode 目标工作模式
 */
export function saveWorkMode(mode: WorkMode): void {
  try {
    globalState.workMode = mode;
    const configPath = getAgentConfigPath();
    const dir = dirname(configPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    let parsed: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try {
        parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
      } catch {
        // 忽略
      }
    }
    parsed.workMode = mode;
    writeFileSync(configPath, JSON.stringify(parsed, null, 2), 'utf-8');
  } catch (e) {
    console.error(`保存工作模式失败:`, e);
  }
}

/**
 * 静态前缀提取算法
 * 对拦截的命令行进行规范解析，提取 Root Command + Sub Command 并进行纯字母数字校验。
 * 例如：
 * - "npm run build" -> "npm run"
 * - "git add src/index.ts" -> "git add"
 * - "python -m pip install" -> null (因为 "-m" 含有非字母数字的特殊符号)
 * @param command 命令文本
 * @returns 提取出的安全前缀，不能提取时返回 null
 */
export function extractSafePrefix(command: string): string | null {
  const parts = command.trim().split(/\s+/);
  if (parts.length < 2) {
    return null;
  }
  const root = parts[0];
  const sub = parts[1];
  
  // 校验子命令必须是纯字母数字，不能带 - 或路径斜杠
  const subRegex = /^[a-zA-Z0-9]+$/;
  if (subRegex.test(sub)) {
    return `${root} ${sub}`;
  }
  return null;
}

/**
 * 校验命令是否命中白名单
 * @param command 命令文本
 * @returns 是否命中
 */
export function checkWhitelist(command: string): boolean {
  const allowed = loadAllowedCommands();
  const trimmed = command.trim();
  
  for (const rule of allowed) {
    if (rule.endsWith(':*')) {
      const prefix = rule.slice(0, -2);
      if (trimmed.startsWith(prefix)) {
        return true;
      }
    } else {
      if (trimmed === rule) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 控制台询问确认交互逻辑
 * @param command 待执行命令
 * @param allowedPrefix 静态安全前缀
 * @returns 用户选择的策略 (once: 单次执行, always: 始终放行前缀, deny: 拒绝)
 */
function askUserPermission(command: string, allowedPrefix: string | null): Promise<'once' | 'always' | 'deny'> {
  return new Promise((resolve) => {
    // 针对非 TTY 环境（如测试），默认执行单次放行，避免产生无限挂起
    if (!process.stdin.isTTY) {
      resolve('once');
      return;
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    console.log(`\n⚠️  [安全提示] Agent 企图执行以下终端命令：`);
    console.log(`   👉  \x1b[33m${command}\x1b[0m`);
    
    if (allowedPrefix) {
      console.log(`选择操作:`);
      console.log(`  [1] 单次放行 (Allow Once)`);
      console.log(`  [2] 始终放行该前缀命令 (Always Allow "${allowedPrefix}:*")`);
      console.log(`  [3] 拒绝执行 (Deny)`);
      
      const ask = () => {
        rl.question(`请选择 [1/2/3]: `, (answer) => {
          const ans = answer.trim();
          if (ans === '1') {
            rl.close();
            resolve('once');
          } else if (ans === '2') {
            rl.close();
            resolve('always');
          } else if (ans === '3') {
            rl.close();
            resolve('deny');
          } else {
            console.log(`无效选择，请重新输入。`);
            ask();
          }
        });
      };
      ask();
    } else {
      console.log(`选择操作:`);
      console.log(`  [1] 单次放行 (Allow Once)`);
      console.log(`  [2] 拒绝执行 (Deny)`);
      
      const ask = () => {
        rl.question(`请选择 [1/2]: `, (answer) => {
          const ans = answer.trim();
          if (ans === '1') {
            rl.close();
            resolve('once');
          } else if (ans === '2') {
            rl.close();
            resolve('deny');
          } else {
            console.log(`无效选择，请重新输入。`);
            ask();
          }
        });
      };
      ask();
    }
  });
}

/**
 * Windows 原生特化：强杀整棵子进程树
 * @param pid 根进程 PID
 */
function killProcessTree(pid: number): Promise<void> {
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
          // 忽略
        }
        resolve();
      });
    } else {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // 忽略
      }
      resolve();
    }
  });
}

/**
 * Windows 原生特化：寻找系统 npm/npx 对应的实际 JS 执行脚本
 * @param name npm 或者是 npx
 * @returns 脚本路径，找不到则返回 null
 */
function resolveNpmCliPath(name: 'npm' | 'npx'): string | null {
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
function parseCommandLine(cmd: string): string[] {
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
 * 终端指令执行核心入口（具沙箱隔离、流式截断、自动后台化等高级机制）
 * @param command 要执行的命令行
 * @param cwd 命令启动的目录（相对/绝对，会自动锁死在工作区安全区内）
 * @param isBackground 是否显式启动为后台驻留任务
 * @param options 超时配置选项
 * @returns 执行结果摘要以及带有 <shell_metadata> 的元数据文本
 */
export async function executeCommandTool(
  command: string,
  cwd?: string,
  isBackground?: boolean,
  options?: { timeoutMs?: number; noOutputTimeoutMs?: number }
): Promise<string> {
  // 1. 安全防护检查：基于硬编码正则阻断复合命令（反重定向、反命令拼接注入）
  const compositeRegex = /[&|<>^%\r\n]/;
  if (compositeRegex.test(command)) {
    throw new Error('拒绝执行：检测到非法的复合连接符或重定向符。终端工具仅支持原子命令。');
  }

  // 2. 沙箱边界校验：强制校验工作目录范围限制
  const rootDir = getAuthorizedDir();
  if (!rootDir) {
    throw new Error('工作区路径未初始化。');
  }
  const targetCwd = cwd ? resolve(rootDir, cwd) : rootDir;
  const isAuthorized = targetCwd === rootDir || targetCwd.startsWith(rootDir + sep);
  if (!isAuthorized) {
    throw new Error('Operation not permitted (Out of bounds)');
  }

  // 3. 全局工作模式拦截规则判定
  loadWorkMode(); // 先从磁盘重载一次工作模式，保障同步
  const workMode = getWorkMode();
  let needApproval = true;

  if (workMode === 'YOLO') {
    needApproval = false;
  } else if (workMode === 'Auto') {
    if (checkWhitelist(command)) {
      needApproval = false;
    }
  }

  if (needApproval) {
    const safePrefix = extractSafePrefix(command);
    const userChoice = await askUserPermission(command, safePrefix);
    if (userChoice === 'deny') {
      throw new Error('Command execution denied by user');
    }
    if (userChoice === 'always' && safePrefix) {
      const allowed = loadAllowedCommands();
      const prefixRule = `${safePrefix}:*`;
      if (!allowed.includes(prefixRule)) {
        allowed.push(prefixRule);
        saveAllowedCommands(allowed);
      }
    }
  }

  // 4. 解析命令执行程序与参数
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

  // 5. 准备流式防爆记录（Disk Spilling）与临时日志输出文件
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

  // 6. 后台执行缓冲及自动阻塞降级
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

/**
 * 格式化任务的返回输出，集成首尾截断和 XML 元数据标签
 * @param taskInfo 任务详情
 * @param totalBytes 输出总字节
 * @param limit 截断单侧长度
 * @returns 格式化的文本结果
 */
function formatTaskResult(taskInfo: TaskInfo, totalBytes: number, limit: number): string {
  const content = totalBytes <= limit * 2
    ? taskInfo.headText
    : `${taskInfo.headText}\n\n... [此处日志因过长被截断，已忽略中间的 ${totalBytes - taskInfo.headText.length - taskInfo.tailText.length} 字节内容] ...\n\n${taskInfo.tailText}`;

  const meta = `\n\n<shell_metadata>\n  <exit_code>${taskInfo.exitCode ?? 'unknown'}</exit_code>\n  <duration_ms>${taskInfo.duration ?? 0}</duration_ms>\n  <log_path>${taskInfo.logPath}</log_path>\n</shell_metadata>`;
  return content + meta;
}

/**
 * 校验日志中是否存在实质性的错误输出
 * @param text 日志文本
 * @returns 是否有实质性报错
 */
function checkHasRealError(text: string): boolean {
  const lowercase = text.toLowerCase();
  const errorKeywords = ['error', 'failed', 'exception', 'fatal', 'invalid', 'cannot', 'permission denied'];
  for (const kw of errorKeywords) {
    if (lowercase.includes(kw)) {
      return true;
    }
  }
  return false;
}
