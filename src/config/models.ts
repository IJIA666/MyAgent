/**
 * 内置大语言模型配置与工厂。
 * 统一管理系统支持的内置模型（如 deepseek-v4-flash 等）的默认参数、环境变量名以及特殊 payload 构建逻辑。
 * 提供依据模型 ID 动态生成标准化连接配置（LlmConfig）的工厂函数。
 */

import { ModelProfile, LlmConfig } from './types.js';

/**
 * 系统内置支持的大模型特征清单。
 * 键为模型的全局唯一标识符（ID）。
 */
export const BUILTIN_MODELS: Record<string, ModelProfile> = {
  'deepseek-v4-flash': {
    id: 'deepseek-v4-flash',
    envKeyName: 'DEEPSEEK_API_KEY',
    envUrlName: 'DEEPSEEK_API_URL',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    buildExtraPayload: (options?: Record<string, unknown>) => {
      // 优先取交互传递的思考等级，兜底使用环境变量，默认设为 high
      const effort = options?.reasoning_effort || process.env.DEEPSEEK_REASONING_EFFORT || 'high';
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
    envKeyName: 'DEEPSEEK_API_KEY',
    envUrlName: 'DEEPSEEK_API_URL',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-pro',
    buildExtraPayload: (options?: Record<string, unknown>) => {
      const effort = options?.reasoning_effort || process.env.DEEPSEEK_REASONING_EFFORT || 'high';
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
 * 根据模型 ID 动态构建大语言模型连接配置。
 * @param id 模型在 BUILTIN_MODELS 中的 ID
 */
export function getModelConfig(id: string): LlmConfig {
  const profile = BUILTIN_MODELS[id];
  if (!profile) {
    throw new Error(`未知的模型 ID: ${id}`);
  }
  const apiKey = process.env[profile.envKeyName];
  if (!apiKey || apiKey.trim() === '') {
    throw new Error(`缺失模型 ${id} 的 API Key: 请在 .env 中配置 ${profile.envKeyName}`);
  }
  let baseUrl = profile.defaultBaseUrl;
  if (profile.envUrlName && process.env[profile.envUrlName]) {
    baseUrl = process.env[profile.envUrlName]!;
  }
  const model = profile.defaultModel;
  const maxTokens = parseInt(process.env.DEEPSEEK_MAX_TOKENS || '4096', 10);
  return { apiKey, baseUrl, model, profile, maxTokens };
}
