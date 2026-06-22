/**
 * @file 集中统一的智能体运行诊断日志管理系统（ Logger ）。
 * 提供分级拦截、 Console 终端彩色输出、文件安全异步 RotatingFile 滚动落盘，
 * 以及针对 Vitest 单元测试静音和进程异常退出时的刷盘防丢失机制。
 */

import { configure, getConsoleSink, getLogger, dispose, withFilter } from "@logtape/logtape";
import type { LogLevel } from "@logtape/logtape";
import { getRotatingFileSink } from "@logtape/file";

const rawLogger = getLogger([]);

/**
 * 根日志记录器包装代理，用于系统内部的诊断信息输出。
 * 兼容处理各种日志级别，并允许第二个参数传入 unknown 以防 catch (e) 产生的类型报错。
 */
export const logger = {
  debug(message: string, propertiesOrError?: unknown): void {
    if (propertiesOrError instanceof Error) {
      rawLogger.debug(message, { error: propertiesOrError.message, stack: propertiesOrError.stack });
    } else if (propertiesOrError && typeof propertiesOrError === "object") {
      rawLogger.debug(message, propertiesOrError as Record<string, unknown>);
    } else {
      rawLogger.debug(message);
    }
  },
  info(message: string, propertiesOrError?: unknown): void {
    if (propertiesOrError instanceof Error) {
      rawLogger.info(message, { error: propertiesOrError.message, stack: propertiesOrError.stack });
    } else if (propertiesOrError && typeof propertiesOrError === "object") {
      rawLogger.info(message, propertiesOrError as Record<string, unknown>);
    } else {
      rawLogger.info(message);
    }
  },
  warn(message: string, propertiesOrError?: unknown): void {
    if (propertiesOrError instanceof Error) {
      rawLogger.warn(message, { error: propertiesOrError.message, stack: propertiesOrError.stack });
    } else if (propertiesOrError && typeof propertiesOrError === "object") {
      rawLogger.warn(message, propertiesOrError as Record<string, unknown>);
    } else {
      rawLogger.warn(message);
    }
  },
  warning(message: string, propertiesOrError?: unknown): void {
    if (propertiesOrError instanceof Error) {
      rawLogger.warning(message, { error: propertiesOrError.message, stack: propertiesOrError.stack });
    } else if (propertiesOrError && typeof propertiesOrError === "object") {
      rawLogger.warning(message, propertiesOrError as Record<string, unknown>);
    } else {
      rawLogger.warning(message);
    }
  },
  error(message: string, propertiesOrError?: unknown): void {
    if (propertiesOrError instanceof Error) {
      rawLogger.error(message, { error: propertiesOrError.message, stack: propertiesOrError.stack });
    } else if (propertiesOrError && typeof propertiesOrError === "object") {
      rawLogger.error(message, propertiesOrError as Record<string, unknown>);
    } else {
      rawLogger.error(message);
    }
  },
  fatal(message: string, propertiesOrError?: unknown): void {
    if (propertiesOrError instanceof Error) {
      rawLogger.fatal(message, { error: propertiesOrError.message, stack: propertiesOrError.stack });
    } else if (propertiesOrError && typeof propertiesOrError === "object") {
      rawLogger.fatal(message, propertiesOrError as Record<string, unknown>);
    } else {
      rawLogger.fatal(message);
    }
  },
};

let isInitialized = false;

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
  const isTest = process.env.VITEST === "true";
  const hasTestLogEnv = process.env.MYAGENT_TEST_LOG === "1";

  // 测试环境下若未指定 MYAGENT_TEST_LOG=1，则不配置任何 sinks，实现物理静音
  if (isTest && !hasTestLogEnv) {
    await configure({
      sinks: {},
      loggers: [
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
      }),
    },
    loggers: [
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
  let val = patch.value;
  if (typeof val === "string" && val.length > 100) {
    val = `[String: ${val.length} chars]`;
  } else if (Array.isArray(val)) {
    val = `[Array: ${val.length} items]`;
  }
  return {
    op: patch.op,
    path: patch.path,
    value: val,
  };
}

