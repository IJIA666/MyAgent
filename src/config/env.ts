/**
 * 配置环境入口模块。
 * 统一承接运行时环境变量读取，避免业务模块直接依赖全局 `process.env`。
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

/**
 * 获取当前运行时环境变量快照。
 * 该函数是配置装配层读取环境变量的唯一入口。
 *
 * @returns 环境变量字典
 */
export function getRuntimeEnv(): Record<string, string | undefined> {
  if (typeof process === 'undefined') {
    return {};
  }

  return process.env;
}

/**
 * 对对象/数组/字符串执行环境变量插值。
 * 支持 `${VAR_NAME}` 占位符语法，未命中的变量会被替换为空字符串。
 *
 * @param value - 待插值的目标值
 * @param env - 环境变量字典
 * @returns 插值后的新值
 */
export function interpolateEnvVars<T>(value: T, env: Record<string, string | undefined> = getRuntimeEnv()): T {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, key: string) => env[key] ?? '') as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => interpolateEnvVars(item, env)) as T;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
      key,
      interpolateEnvVars(entryValue, env),
    ]);
    return Object.fromEntries(entries) as T;
  }

  return value;
}

/**
 * 更新根目录 `.env` 文件中的指定键值，并同步回写当前运行时环境变量。
 *
 * @param key - 环境变量名
 * @param value - 环境变量值
 */
export function updateEnvVariable(key: string, value: string): void {
  const envFilePath = resolve('.env');
  const escapedValue = value.replace(/\r?\n/g, '\\n');
  const nextLine = `${key}=${escapedValue}`;

  let lines: string[] = [];
  if (existsSync(envFilePath)) {
    lines = readFileSync(envFilePath, 'utf-8').split(/\r?\n/);
  }

  let updated = false;
  const nextLines = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      updated = true;
      return nextLine;
    }
    return line;
  });

  if (!updated) {
    nextLines.push(nextLine);
  }

  const content = nextLines
    .filter((line, index, array) => !(index === array.length - 1 && line === ''))
    .join('\n');
  writeFileSync(envFilePath, content + '\n', 'utf-8');

  if (typeof process !== 'undefined') {
    process.env[key] = value;
  }
}

/**
 * 仅更新当前运行时环境变量，不触碰 `.env` 持久化文件。
 *
 * @param key - 环境变量名
 * @param value - 环境变量值
 */
export function setRuntimeEnvVariable(key: string, value: string): void {
  if (typeof process !== 'undefined') {
    process.env[key] = value;
  }
}

/**
 * 仅删除当前运行时环境变量，不触碰 `.env` 持久化文件。
 *
 * @param key - 环境变量名
 */
export function deleteRuntimeEnvVariable(key: string): void {
  if (typeof process !== 'undefined') {
    delete process.env[key];
  }
}
