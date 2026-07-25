/**
 * @file 集中统一的智能体运行诊断日志管理系统（ Logger ）。
 * 提供分级拦截、 Console 终端彩色输出、文件安全异步 RotatingFile 滚动落盘，
 * 以及针对 Vitest 单元测试静音和进程异常退出时的刷盘防丢失机制。
 *
 * 采用两阶段初始化：
 * 1. 模块加载期（bootstrap）：只配置控制台 sink，不创建任何文件。
 * 2. 授权 workspace 确认后：通过 {@link configureFileSink} 幂等地添加文件 sink，
 *    写入 `<project-data>/logs/run.log`。
 */

/**
 * 结构化日志的统一 component 名称常量。
 */
export const LOG_COMPONENT = {
  TOOL_EFFECT: 'tool_effect',
  TOOL_DIAGNOSTICS: 'tool_diagnostics',
  DIRECTORY_MEASUREMENT: 'directory_measurement',
  SKILL_RELOAD: 'skill_reload',
  PLUGIN_RUNNER: 'plugin_runner',
} as const;

/**
 * 结构化日志的统一事件名常量。
 */
export const LOG_EVENT = {
  // tool_effect
  TOOL_EFFECT_RESOLVED: 'tool_effect_resolved',
  // tool_diagnostics
  COMMAND_ANALYSIS_COMPLETED: 'command_analysis_completed',
  PERMISSION_DECISION_RESOLVED: 'permission_decision_resolved',
  APPROVAL_STATE_CHANGED: 'approval_state_changed',
  TOOL_EXECUTION_STATE_CHANGED: 'tool_execution_state_changed',
  // directory_measurement
  DIRECTORY_MEASUREMENT_STARTED: 'directory_measurement_started',
  DIRECTORY_MEASUREMENT_FINISHED: 'directory_measurement_finished',
  // skill_reload
  SKILL_WATCH_EVENT: 'skill_watch_event',
  SKILL_CACHE_REFRESHED: 'skill_cache_refreshed',
  SKILL_WATCHER_CLOSED: 'skill_watcher_closed',
  // runtime config
  RUNTIME_CONFIG_LOADED: 'runtime_config_loaded',
  MODEL_SWITCH_SUCCEEDED: 'model_switch_succeeded',
  MODEL_SWITCH_FAILED: 'model_switch_failed',
  MODEL_SAVE_DEFAULT_FAILED: 'model_save_default_failed',
} as const;

import { configure, getConsoleSink, getJsonLinesFormatter, getLogger, dispose, reset, withFilter } from "@logtape/logtape";
import type { LogLevel } from "@logtape/logtape";
import { getRotatingFileSink } from "@logtape/file";
import { existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { sanitizeDiagnosticData } from './diagnostic-sanitizer.js';

const rawLogger = getLogger([]);

/** 当前进程中由配置边界装载的用户自定义诊断脱敏模式。 */
let diagnosticPatterns: string[] = [];

/**
 * 设置统一 logger 使用的用户自定义脱敏模式。
 *
 * @param patterns - 已由配置边界校验过的正则模式
 */
export function setDiagnosticSanitizerPatterns(patterns: readonly string[]): void {
  diagnosticPatterns = [...patterns];
}

/** 将 unknown 类型的第二参数适配为 LogTape 兼容的调用形式 */
function callRawLogger(
  method: (msg: string, props?: Record<string, unknown>) => void,
  message: string,
  propertiesOrError?: unknown
): void {
  const sanitizeOptions = { customPatterns: diagnosticPatterns };
  const safeMessage = sanitizeDiagnosticData(message, 'operational', sanitizeOptions);
  const renderedMessage = typeof safeMessage === 'string' ? safeMessage : String(safeMessage);
  if (propertiesOrError instanceof Error) {
    const safeError = sanitizeDiagnosticData({ error: propertiesOrError.message, stack: propertiesOrError.stack }, 'operational', sanitizeOptions);
    method(renderedMessage, safeError as Record<string, unknown>);
  } else if (propertiesOrError !== null && typeof propertiesOrError === "object") {
    const safeProperties = sanitizeDiagnosticData(propertiesOrError, 'operational', sanitizeOptions);
    method(renderedMessage, safeProperties as Record<string, unknown>);
  } else {
    method(renderedMessage);
  }
}

export const logger = {
  debug(message: string, propertiesOrError?: unknown): void {
    callRawLogger(rawLogger.debug.bind(rawLogger), message, propertiesOrError);
  },
  info(message: string, propertiesOrError?: unknown): void {
    callRawLogger(rawLogger.info.bind(rawLogger), message, propertiesOrError);
  },
  warn(message: string, propertiesOrError?: unknown): void {
    callRawLogger(rawLogger.warn.bind(rawLogger), message, propertiesOrError);
  },
  warning(message: string, propertiesOrError?: unknown): void {
    callRawLogger(rawLogger.warning.bind(rawLogger), message, propertiesOrError);
  },
  error(message: string, propertiesOrError?: unknown): void {
    callRawLogger(rawLogger.error.bind(rawLogger), message, propertiesOrError);
  },
  fatal(message: string, propertiesOrError?: unknown): void {
    callRawLogger(rawLogger.fatal.bind(rawLogger), message, propertiesOrError);
  },
};

let isInitialized = false;
/** 是否已配置文件 sink，确保幂等。 */
let fileSinkConfigured = false;

/**
 * 初始化全局日志系统引导阶段。
 * 只配置控制台终端输出，不创建任何日志文件。
 * 在授权 workspace 确认前调用，确保启动日志有控制台输出通道。
 *
 * @returns 异步初始化结果的 Promise
 */
export async function initLogger(): Promise<void> {
  if (isInitialized) {
    return;
  }
  isInitialized = true;
  const isTest = process.env.VITEST === "true";
  const hasTestLogEnv = process.env.MYAGENT_TEST_LOG === "1";

  // 测试环境下若未指定 MYAGENT_TEST_LOG=1，则不配置任何 sinks，实现物理静音
  if (isTest && !hasTestLogEnv) {
    await configure({
      sinks: {},
      loggers: [
        {
          category: ["logtape", "meta"],
          lowestLevel: "warning",
          sinks: [],
        },
        {
          category: [],
          sinks: [],
        },
      ],
    });
    return;
  }

  // 正常环境：只配置控制台 sink（LOG_LEVEL 过滤，默认 INFO）
  const rawLogLevel = (process.env.LOG_LEVEL || "info").toLowerCase();
  const validLevels: LogLevel[] = ["debug", "info", "warning", "error", "fatal"];
  const consoleLevel = (validLevels.includes(rawLogLevel as LogLevel) ? rawLogLevel : "info") as LogLevel;

  await configure({
    sinks: {
      console: withFilter(getConsoleSink(), consoleLevel),
    },
    loggers: [
      {
        category: ["logtape", "meta"],
        lowestLevel: "warning",
        sinks: ["console"],
      },
      {
        category: [],
        lowestLevel: "debug",
        sinks: ["console"],
      },
    ],
  });
}

/**
 * 在授权 workspace 确认后，幂等地配置文件日志 sink。
 * 将完整诊断日志（DEBUG 及以上级别）写入 `<logDir>/run.log`，
 * 支持 10MB/5 文件的自动轮转。
 *
 * 该函数是幂等的：多次调用只生效一次。
 * 如果日志目录创建失败，输出控制台错误但不阻止应用继续运行。
 *
 * @param logDir - 项目日志目录的绝对路径（如 `ApplicationPaths.logsDir`）
 * @returns 文件 sink 配置成功时 resolve true，目录不可写时 resolve false
 */
export async function configureFileSink(logDir: string): Promise<boolean> {
  if (fileSinkConfigured) {
    return true;
  }

  try {
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    // LogTape 的 configure() 不能重复调用，必须先 reset。
    // reset 会清空所有 sink 和 logger 配置，因此 console sink 也需要在此重新配置。
    await reset();

    const runLogPath = resolve(logDir, 'run.log');
    const rawLogLevel = (process.env.LOG_LEVEL || "info").toLowerCase();
    const validLevels: LogLevel[] = ["debug", "info", "warning", "error", "fatal"];
    const consoleLevel = (validLevels.includes(rawLogLevel as LogLevel) ? rawLogLevel : "info") as LogLevel;

    await configure({
      sinks: {
        console: withFilter(getConsoleSink(), consoleLevel),
        file: getRotatingFileSink(runLogPath, {
          maxSize: 10 * 1024 * 1024, // 10MB
          maxFiles: 5,
          formatter: getJsonLinesFormatter({
            message: "rendered",
            properties: "flatten"
          }),
        }),
      },
      loggers: [
        {
          category: ["logtape", "meta"],
          lowestLevel: "warning",
          sinks: ["console", "file"],
        },
        {
          category: [],
          lowestLevel: "debug",
          sinks: ["console", "file"],
        },
      ],
    });

    fileSinkConfigured = true;
    return true;
  } catch {
    logger.warn('[Logger] 无法创建日志目录或配置文件 sink', {
      component: 'logger',
      event: 'file_sink_config_failed',
      logDir,
    });
    return false;
  }
}

/**
 * 异步释放日志系统持有的所有资源，强制刷盘内存中的缓存数据。
 *
 * @returns 异步刷盘释放结果的 Promise
 */
export async function disposeLogger(): Promise<void> {
  await dispose();
}

/**
 * 结构化补丁数据类型定义。
 */
export interface SimplePatch {
  op: string;
  path: (string | number)[];
  value?: unknown;
}

/**
 * 对单个 Immer 变更补丁数据执行 Map 压缩摘要，避免大文本或大数组撑爆日志。
 *
 * @param patch - 待压缩的 Immer 原始补丁数据
 * @returns 压缩折叠后的补丁信息对象
 */
export function compressPatch(patch: { op: string; path: (string | number)[]; value?: unknown }): SimplePatch {
  const safePatch = sanitizeDiagnosticData(patch, 'audit', { customPatterns: diagnosticPatterns }) as {
    op?: unknown;
    path?: unknown;
    value?: unknown;
  };
  let val = safePatch.value;
  if (typeof val === "string" && val.length > 100) {
    val = `[String: ${val.length} chars]`;
  } else if (Array.isArray(val)) {
    val = `[Array: ${val.length} items]`;
  }
  return {
    op: typeof safePatch.op === 'string' ? safePatch.op : '[REDACTED]',
    path: Array.isArray(safePatch.path) ? safePatch.path as (string | number)[] : [],
    value: val,
  };
}

