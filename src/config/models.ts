/**
 * 内置大语言模型配置与工厂。
 * 统一管理系统支持的内置模型（如 deepseek-v4-flash 等）的默认参数、环境变量名以及特殊 payload 构建逻辑。
 * 提供依据模型 ID 动态生成标准化连接配置（LlmConfig）的工厂函数。
 */

import { ModelProfile, LlmConfig, VALID_REASONING_EFFORTS, ReasoningEffort } from './types.js';
import { getRuntimeEnv } from './env.js';

/**
 * 系统内置支持的大模型特征清单。
 * 键为模型的全局唯一标识符（ID）。
 */
export const BUILTIN_MODELS: Record<string, ModelProfile> = {
  'deepseek-v4-flash': {
    id: 'deepseek-v4-flash',
    envKeyName: 'AGENT_LLM_API_KEY',
    envUrlName: 'AGENT_LLM_BASE_URL',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash[1m]',
    /** 预设上下文最大窗口为 1000000 tokens */
    contextWindow: 1000000,
    /** 预设采样温度为 0.2 */
    temperature: 0.2,
    /** 预设超时时间为 600 秒（毫秒） */
    timeout: 600000,
    /** 预设最大重试次数为 3 次 */
    maxRetries: 3,
    buildExtraPayload: (options?: Record<string, unknown>, config?: LlmConfig) => {
      // 优先取交互传递的思考等级，其次取已初始化的配置，默认设为 high
      const effort = options?.reasoning_effort || config?.reasoningEffort || 'high';
      if (effort === 'disabled') {
        return {}; // 禁用推理模式时返回空 payload
      }
      // 启用推理模式时，按官方规范强制带上 thinking 参数
      return {
        thinking: { type: "enabled" },
        reasoning_effort: effort
      };
    }
  },
  'deepseek-v4-pro': {
    id: 'deepseek-v4-pro',
    envKeyName: 'AGENT_LLM_API_KEY',
    envUrlName: 'AGENT_LLM_BASE_URL',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-pro[1m]',
    /** 预设上下文最大窗口为 1000000 tokens */
    contextWindow: 1000000,
    /** 预设采样温度为 0.2 */
    temperature: 0.2,
    /** 预设超时时间为 600 秒（毫秒） */
    timeout: 600000,
    /** 预设最大重试次数为 3 次 */
    maxRetries: 3,
    buildExtraPayload: (options?: Record<string, unknown>, config?: LlmConfig) => {
      const effort = options?.reasoning_effort || config?.reasoningEffort || 'high';
      if (effort === 'disabled') {
        return {};
      }
      return {
        thinking: { type: "enabled" },
        reasoning_effort: effort
      };
    }
  }
};

/**
 * 解析各种形式的上下文窗口大小配置（支持数字或类似 1m、128k 的单位缩写形式）。
 *
 * @param val - 配置字符串
 * @returns 解析出的上下文窗口数字大小
 */
export function parseContextWindow(val: string): number {
  const clean = val.trim().toLowerCase();
  const num = parseFloat(clean);
  if (isNaN(num)) {
    return 32000; // 无法解析时采用绝对安全的保守下限值
  }
  if (clean.endsWith('m')) {
    return Math.floor(num * 1000000);
  }
  if (clean.endsWith('k')) {
    return Math.floor(num * 1000);
  }
  return Math.floor(num);
}

/**
 * 根据模型 ID 动态构建大语言模型连接配置，支持通过环境变量进行高优先级覆写。
 *
 * @param id - 模型在 BUILTIN_MODELS 中的 ID
 * @returns 构建完成的大语言模型连接配置对象
 */
export function getModelConfig(id: string, env: Record<string, string | undefined> = getRuntimeEnv()): LlmConfig {
  const profile = BUILTIN_MODELS[id];
  if (!profile) {
    throw new Error(`未知的模型 ID: ${id}`);
  }
  const apiKey = env[profile.envKeyName];
  if (!apiKey || apiKey.trim() === '') {
    throw new Error(`缺失模型 ${id} 的 API Key: 请在 .env 中配置 ${profile.envKeyName}`);
  }
  let baseUrl = profile.defaultBaseUrl;
  if (profile.envUrlName && env[profile.envUrlName]) {
    baseUrl = env[profile.envUrlName]!;
  }

  // 优先读取环境变量进行模型名称与最大输出 Tokens 的覆盖
  const rawModel = env.AGENT_LLM_MODEL || profile.defaultModel;
  const maxTokens = parseInt(env.AGENT_LLM_MAX_TOKENS || '4096', 10);

  // 匹配并剥除模型名中的窗口尺寸后缀（如 [1m]、[128k] 等）
  let model = rawModel;
  let extractedWindow: number | null = null;
  const suffixRegex = /\[(\d+)([km])\]/i;
  const match = rawModel.match(suffixRegex);
  if (match) {
    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    if (unit === 'm') {
      extractedWindow = value * 1000000;
    } else if (unit === 'k') {
      extractedWindow = value * 1000;
    }
    // 自动剥除后缀，以防向第三方 API 发送模型参数时因携带非标准后缀发生接口报错
    model = rawModel.replace(suffixRegex, '');
  }

  // 级联读取环境变量或使用模型预设的默认值。若检测到模型名已被覆写但缺失窗口环境变量配置且无后缀特征，主动退化至 32000 保守值防爆
  const isModelOverridden = env.AGENT_LLM_MODEL !== undefined && env.AGENT_LLM_MODEL !== profile.defaultModel;
  let contextWindow = profile.contextWindow || 1000000;
  if (env.AGENT_LLM_CONTEXT_WINDOW) {
    contextWindow = parseContextWindow(env.AGENT_LLM_CONTEXT_WINDOW);
  } else if (extractedWindow !== null) {
    contextWindow = extractedWindow;
  } else if (isModelOverridden) {
    contextWindow = 32000;
  }

  const temperature = env.AGENT_LLM_TEMPERATURE
    ? parseFloat(env.AGENT_LLM_TEMPERATURE)
    : profile.temperature;

  const timeout = env.AGENT_LLM_TIMEOUT
    ? parseInt(env.AGENT_LLM_TIMEOUT, 10)
    : (profile.timeout || 600000);

  const maxRetries = env.AGENT_LLM_MAX_RETRIES
    ? parseInt(env.AGENT_LLM_MAX_RETRIES, 10)
    : (profile.maxRetries || 3);

  // 解析自定义请求头环境变量，支持分号或换行符分割的名值对
  let headers: Record<string, string> | undefined = profile.headers;
  const envHeaders = env.AGENT_LLM_HEADERS;
  if (envHeaders) {
    headers = { ...(headers || {}) };
    const lines = envHeaders.split(/[;\n\r]+/);
    for (const line of lines) {
      if (!line.trim()) continue;
      const colonIdx = line.indexOf(':');
      if (colonIdx !== -1) {
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();
        if (key) {
          headers[key] = value;
        }
      }
    }
  }

  // 提取推理努力度并执行值域 Fail-Fast 校验
  const reasoningEffort = env.AGENT_LLM_REASONING_EFFORT;
  let validatedEffort: ReasoningEffort | undefined = undefined;
  if (reasoningEffort !== undefined && reasoningEffort.trim() !== '') {
    const trimmedEffort = reasoningEffort.trim();
    if (!(VALID_REASONING_EFFORTS as readonly string[]).includes(trimmedEffort)) {
      throw new Error(`[配置] 不合法的 AGENT_LLM_REASONING_EFFORT 值: "${reasoningEffort}"。仅允许 ${VALID_REASONING_EFFORTS.map(e => `'${e}'`).join(' | ')}。`);
    }
    validatedEffort = trimmedEffort as ReasoningEffort;
  }

  return {
    apiKey,
    baseUrl,
    model,
    profile,
    maxTokens,
    contextWindow,
    temperature,
    timeout,
    maxRetries,
    headers,
    reasoningEffort: validatedEffort
  };
}
