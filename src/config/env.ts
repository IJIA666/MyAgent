/**
 * @file 环境变量解析与热修改工具集。
 * 提供对环境变量的非破坏性修改更新、必填项 Fail-fast 校验以及环境变量插值表达式的递归解析。
 */

/* eslint-disable n/no-process-env */
import fs from 'fs';
import path from 'path';

/**
 * 更新 .env 文件中指定键的值。
 * 使用基于正则的非破坏性替换策略，安全保留原有的注释和排版结构。
 * 若键不存在，则在文件末尾追加。
 *
 * @param key - 环境变量名（例如 'AGENT_LLM_MODEL'）
 * @param value - 新的环境变量值
 */
export function updateEnvVariable(key: string, value: string): void {
  const envPath = path.resolve(process.cwd(), '.env');
  
  let envContent = '';
  try {
    envContent = fs.readFileSync(envPath, 'utf8');
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code !== 'ENOENT') {
      throw err;
    }
  }

  const regex = new RegExp(`^\\s*${key}=.*$`, 'm');
  const newRow = `${key}=${value}`;

  if (regex.test(envContent)) {
    envContent = envContent.replace(regex, newRow);
  } else {
    if (envContent.length > 0 && !envContent.endsWith('\n')) {
      envContent += '\n';
    }
    envContent += newRow + '\n';
  }

  fs.writeFileSync(envPath, envContent, 'utf8');
}

/**
 * 读取必填环境变量，缺失时抛出包含变量名的明确错误。
 * 实现 fail-fast 策略，阻止在缺少关键配置时继续启动。
 *
 * @param name - 环境变量名称
 * @returns 环境变量的值
 * @throws 当环境变量未设置或为空字符串时
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `必填环境变量 "${name}" 未设置。请在 .env 文件中配置该变量后重新启动。`
    );
  }
  return value.trim();
}

/**
 * 递归扫描配置值，将 ${VAR} 格式的占位符替换为指定 env 环境对象中的实际值。
 * 若对应的环境变量不存在，保留占位符原文不做替换。
 *
 * @param value - 待处理的配置值（支持字符串、对象、数组的递归处理）
 * @param env - 可选的环境变量数据源，默认使用 process.env
 * @returns 完成插值替换后的配置值
 */
export function interpolateEnvVars(value: unknown, env: Record<string, string | undefined> = process.env): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)}/g, (original, varName: string) => {
      const envValue = env[varName];
      return envValue !== undefined ? envValue : original;
    });
  }

  if (Array.isArray(value)) {
    return value.map(item => interpolateEnvVars(item, env));
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = interpolateEnvVars(val, env);
    }
    return result;
  }

  return value;
}
