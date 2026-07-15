/**
 * @file 集中统一的智能体运行诊断日志管理系统（ Logger ）。
 * 提供分级拦截、 Console 终端彩色输出、文件安全异步 RotatingFile 滚动落盘，
 * 以及针对 Vitest 单元测试静音和进程异常退出时的刷盘防丢失机制。
 */

/**
 * 结构化日志的统一 component 名称常量。
 */
export const LOG_COMPONENT = {
  TOOL_EFFECT: 'tool_effect',
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

import { configure, getConsoleSink, getJsonLinesFormatter, getLogger, dispose, withFilter } from "@logtape/logtape";
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

/**
 * 确保运行时日志根目录 `.myagent` 存在。
 * 这是启动链路最早访问 `.myagent` 的位置，必须先自愈目录，再配置文件 Sink。
 */
function ensureLoggerRuntimeDir(): void {
  const runtimeDir = resolve(".myagent");
  if (!existsSync(runtimeDir)) {
    mkdirSync(runtimeDir, { recursive: true });
  }
}

/**
 * 初始化全局日志系统配置。
 * 根据环境变量配置 Console 终端彩色输出和文件落盘轮转写入，并自动处理测试静音。
 * 
 * @returns 异步初始化结果的 Promise 
 */
export async function initLogger(): Promise<void> {
  if (isInitialized) {
    return;
  }
  isInitialized = true;
  // 日志文件 Sink 会写入 `.myagent/run.log`。若用户删掉整个 `.myagent`，这里必须先重建根目录。
  ensureLoggerRuntimeDir();
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

  // 正常环境或测试中强制开启日志时
  // 终端 ConsoleSink 根据 LOG_LEVEL 过滤（ 默认 INFO 级 ），而文件落盘全量捕获（ 包含 DEBUG 及以上 ）
  const rawLogLevel = (process.env.LOG_LEVEL || "info").toLowerCase();

  // 校验并映射合法的 LogTape 级别，避免非法配置崩溃
  const validLevels: LogLevel[] = ["debug", "info", "warning", "error", "fatal"];
  const consoleLevel = (validLevels.includes(rawLogLevel as LogLevel) ? rawLogLevel : "info") as LogLevel;

  await configure({
    sinks: {
      console: withFilter(getConsoleSink(), consoleLevel),
      file: getRotatingFileSink(".myagent/run.log", {
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

