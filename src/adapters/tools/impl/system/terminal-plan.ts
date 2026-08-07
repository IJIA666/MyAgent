/**
 * ShellExecutionPlan 工厂模块。
 * 核心职责：
 * 1. 根据 shellKind + 原始命令 + 配置上下文一次性生成不可变的 ShellExecutionPlan；
 * 2. 负责 shell family 的决议（auto → 具体值）、平台特化选项的填充以及可执行参数的生成。
 */

import { resolve, dirname, delimiter, join } from 'path';
import { existsSync } from 'fs';
import { getRuntimeEnv } from '../../../../config/env.js';
import type { ShellKind, ResolvedShellKind, ShellExecutionPlan, PlatformExecutionOptions } from './terminal-types.js';

/** Plan 工厂的输入配置上下文 */
export interface PlanConfig {
  /** 全局配置中的默认 shell family */
  defaultShellFamily?: ShellKind;
  /** 当前进程运行的平台，默认取 process.platform */
  platform?: NodeJS.Platform;
}

/** 平台默认 shell family 映射表 */
const PLATFORM_DEFAULT_SHELL: Record<string, ResolvedShellKind> = {
  win32: 'powershell',
  darwin: 'posix',
  linux: 'posix',
  aix: 'posix',
  freebsd: 'posix',
  openbsd: 'posix',
  sunos: 'posix',
};

/** Shell 包装程序及其固定前置参数。 */
export interface ShellLauncher {
  /** 可执行文件路径或名称。 */
  executable: string;
  /** 执行用户命令前追加的固定参数。 */
  argsPrefix: string[];
}

/** 将 PATH 拆分为目录列表，自动忽略空段。 */
function splitPathEntries(pathValue: string | undefined): string[] {
  if (!pathValue) {
    return [];
  }
  return pathValue
    .split(delimiter)
    .map(entry => entry.trim())
    .filter(Boolean);
}

/** 在 PATH 中探测候选可执行文件。 */
function findExecutableInPath(
  candidates: string[],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = getRuntimeEnv(),
): string | null {
  const pathEntries = splitPathEntries(env.PATH);
  const pathExts = platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
      .split(';')
      .map(ext => ext.toLowerCase())
    : [''];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }

    for (const dir of pathEntries) {
      const basePath = join(dir, candidate);
      if (existsSync(basePath)) {
        return basePath;
      }

      if (platform === 'win32') {
        const lowerCandidate = candidate.toLowerCase();
        const hasKnownExt = pathExts.some(ext => lowerCandidate.endsWith(ext));
        if (hasKnownExt) {
          continue;
        }

        for (const ext of pathExts) {
          const withExt = basePath + ext.toLowerCase();
          if (existsSync(withExt)) {
            return withExt;
          }
        }
      }
    }
  }

  return null;
}

/**
 * 为已决议 shell family 选择实际 shell 包装程序。
 * 返回 null 表示当前策略不需要额外 shell 包装。
 *
 * @param kind - 已决议的 Shell family
 * @param platform - 当前运行平台
 * @param env - 启动期环境变量快照
 * @returns 可用的 Shell launcher；当前平台无法解析时返回 null
 */
export function resolveShellLauncher(
  kind: ResolvedShellKind,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = getRuntimeEnv(),
): ShellLauncher | null {
  if (kind === 'cmd') {
    if (platform !== 'win32') {
      return null;
    }
    const cmdPath = findExecutableInPath(
      [
        env.ComSpec ?? '',
        join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
        'cmd.exe',
        'cmd',
      ].filter(Boolean),
      platform,
      env,
    );
    return cmdPath ? { executable: cmdPath, argsPrefix: ['/d', '/s', '/c'] } : null;
  }

  if (kind === 'powershell') {
    const powershellPath = platform === 'win32'
      ? findExecutableInPath(['pwsh.exe', 'powershell.exe', 'powershell'], platform, env)
      : findExecutableInPath(['pwsh', 'powershell'], platform, env);
    return powershellPath
      ? { executable: powershellPath, argsPrefix: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'] }
      : null;
  }

  if (platform === 'win32') {
    const posixShellPath = findExecutableInPath(['bash.exe', 'bash', 'sh.exe', 'sh'], platform, env);
    return posixShellPath ? { executable: posixShellPath, argsPrefix: ['-c'] } : null;
  }

  return null;
}

/**
 * 按优先级决议 shell family：显式传入 > 全局配置 > 平台默认。
 *
 * @param input - 模型传入的 shellKind，可能为 undefined（未传）
 * @param config - Plan 工厂配置上下文
 * @returns 已决议的具体 shell family
 */
export function resolveShellKind(
  input: ShellKind | undefined,
  config?: PlanConfig,
): ResolvedShellKind {
  const platform = config?.platform ?? process.platform;

  // 1. 模型显式传入非 auto 值，直接使用
  if (input && input !== 'auto') {
    return input as ResolvedShellKind;
  }

  // 2. 全局配置覆盖
  const configured = config?.defaultShellFamily;
  if (configured && configured !== 'auto') {
    return configured as ResolvedShellKind;
  }

  // 3. 平台默认
  return PLATFORM_DEFAULT_SHELL[platform] ?? 'posix';
}

/**
 * 判定给定的 shell family 在当前平台上是否可用。
 * `cmd` 仅在 Windows 上可用；`powershell` 和 `posix` 跨平台均可配置。
 *
 * @param kind - 待检查的已决议 shell family
 * @param platform - 当前平台
 * @returns 是否支持
 */
export function isShellKindSupportedOnPlatform(
  kind: ResolvedShellKind,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (kind === 'posix' && platform !== 'win32') {
    return true;
  }
  return resolveShellLauncher(kind, platform) !== null;
}

/**
 * 为各 shell family 填充平台特化执行选项。
 *
 * @param resolvedKind - 已决议的 shell family
 * @param platform - 当前运行平台
 * @returns 平台特化执行选项
 */
export function buildPlatformOptions(
  resolvedKind: ResolvedShellKind,
  platform: NodeJS.Platform = process.platform,
): PlatformExecutionOptions {
  const isWindows = platform === 'win32';

  // 进程树强杀命令模板：Windows 与 POSIX 均配置（killProcessTree 会对根进程补 SIGKILL）。
  let killCommand: string[];
  if (isWindows) {
    // Windows：taskkill /T 递归杀完整进程树（含根进程）。
    killCommand = ['taskkill', '/PID', '{pid}', '/T', '/F'];
  } else {
    // POSIX：pkill -P 杀直接子进程（配合 killProcessTree 对根进程的 SIGKILL 补杀，
    // 覆盖父 + 直接子两层；孙进程为尽力回收的已知边界）。
    killCommand = ['pkill', '-P', '{pid}'];
  }

  // npm/npx 重定向仅在 Windows 上需要（绕过 shell: false 无法调用 .cmd 的问题）
  const npmRewrite = isWindows;

  // PowerShell 编码引导仅在 shellKind=powershell 时预置
  const encodingBootstrap =
    resolvedKind === 'powershell'
      ? "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}; "
      : null;

  return {
    killCommand,
    npmRewrite,
    encodingBootstrap,
    shellFlag: false,
  };
}

/**
 * 查找 Windows 平台下 npm/npx 对应的实际 JS CLI 脚本路径。
 * 参见 CVE-2024-27980：shell: false 时无法直接 spawn .cmd 文件。
 *
 * @param name - 'npm' 或 'npx'
 * @returns CLI 脚本路径，找不到则返回 null
 */
function resolveNpmCliPath(name: 'npm' | 'npx'): string | null {
  const nodeDir = dirname(process.execPath);
  const runtimeEnv = getRuntimeEnv();
  const possiblePaths = [
    resolve(nodeDir, 'node_modules/npm/bin', `${name}-cli.js`),
    resolve(nodeDir, 'node_modules/npm/bin', `${name}.js`),
    resolve(runtimeEnv.APPDATA || '', 'npm/node_modules/npm/bin', `${name}-cli.js`),
  ];

  for (const p of possiblePaths) {
    if (existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * 命令行分割解析算法，支持双引号和单引号转义空格。
 *
 * @param cmd - 命令行文本
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
 * 将核心命令文本解析为可执行参数（executable + argv）。
 * 在 Windows + npmRewrite 场景下，对 npm/npx 执行路径重定向。
 *
 * @param coreCommand - 归一化后的核心命令文本
 * @param options - 平台特化选项
 * @param platform - 当前运行平台
 * @returns 包含 executable 和 argv 的元组
 */
function parseCommandToExecutable(
  coreCommand: string,
  resolvedKind: ResolvedShellKind,
  options: PlatformExecutionOptions,
  platform: NodeJS.Platform = process.platform,
): { executable: string; argv: string[] } {
  if (!coreCommand.trim()) {
    throw new Error('命令不能为空。');
  }

  const launcher = resolveShellLauncher(resolvedKind, platform);
  if (launcher) {
    return {
      executable: launcher.executable,
      argv: [...launcher.argsPrefix, coreCommand],
    };
  }

  const cmdArgs = parseCommandLine(coreCommand);
  if (cmdArgs.length === 0) {
    throw new Error('命令不能为空。');
  }

  let exe = cmdArgs[0];
  const args = cmdArgs.slice(1);

  // Windows npm/npx 漏洞修复重定向
  if (platform === 'win32' && options.npmRewrite) {
    const lowerExe = exe.toLowerCase();
    if (lowerExe === 'npm' || lowerExe === 'npx') {
      const cliPath = resolveNpmCliPath(lowerExe as 'npm' | 'npx');
      if (cliPath) {
        args.unshift(cliPath);
        exe = process.execPath;
      }
    }
  }

  return { executable: exe, argv: args };
}

/**
 * 创建 ShellExecutionPlan 工厂函数。
 * 根据 shellKind + 原始命令 + 配置上下文，一次性生成不可变的执行计划。
 *
 * @param command - 原始命令文本
 * @param shellKind - 模型传入的 shell family（可选，默认 undefined → 使用 auto 语义）
 * @param config - Plan 工厂配置上下文
 * @returns 不可变的 ShellExecutionPlan 数据对象
 * @throws 当显式指定的 shell family 在当前平台上不受支持时抛出
 */
export function createShellExecutionPlan(
  command: string,
  shellKind?: ShellKind,
  config?: PlanConfig,
): ShellExecutionPlan {
  const platform = config?.platform ?? process.platform;
  const resolvedKind = resolveShellKind(shellKind, config);

  // 边界检查：当前决议出的 shell family 在当前平台或环境中不可用时，给出明确失败
  if (!isShellKindSupportedOnPlatform(resolvedKind, platform)) {
    const sourceLabel = shellKind && shellKind !== 'auto' ? `显式指定的 "${shellKind}"` : `"${resolvedKind}"`;
    throw new Error(
      `不支持该 shell family: ${sourceLabel} 在当前平台 "${platform}" 上不可用。` +
      '请安装对应 shell，或改用与当前环境兼容的 shell family。',
    );
  }

  const platformOptions = buildPlatformOptions(resolvedKind, platform);
  const coreCommand = command.trim();
  const { executable, argv } = parseCommandToExecutable(coreCommand, resolvedKind, platformOptions, platform);

  return {
    shellKind: resolvedKind,
    coreCommand,
    executable,
    argv,
    platformOptions,
  };
}
