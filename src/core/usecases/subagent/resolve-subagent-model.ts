/**
 * @file 子代理模型解析器。
 * 优先级链对齐官方 `getAgentModel` 的骨架：env > Agent 工具参数 > 定义 frontmatter > inherit。
 * 值域限定为 `inherit` 与 `BUILTIN_MODELS` 已注册 profile ID（MyAgent 无 Claude 式族别名与
 * tier 体系，官方 `aliasMatchesParentTier` 语义不在本阶段落地）；未知值返回校验错误，
 * 不静默回退父模型。
 */
import { BUILTIN_MODELS } from '../../../config/models.js';

/** 子代理模型解析成功结果。 */
export type ResolvedSubagentModel =
  | { readonly kind: 'inherit' }
  | { readonly kind: 'profile'; readonly profileId: string };

/** 子代理模型解析结果：成功或带可诊断信息的校验错误。 */
export type SubagentModelResolution =
  | { readonly ok: true; readonly resolved: ResolvedSubagentModel }
  | { readonly ok: false; readonly error: string };

/** 可供模型/定义声明的全部合法值（inherit + 已注册 profile ID）。 */
export function availableSubagentModels(): readonly string[] {
  return Object.freeze(['inherit', ...Object.keys(BUILTIN_MODELS)]);
}

/**
 * 按优先级解析子代理模型，并在每一级校验值域。
 *
 * @param envModel - 环境变量 `MYAGENT_SUBAGENT_MODEL` 的值
 * @param toolModel - Agent 工具 `model` 参数
 * @param definitionModel - 定义 frontmatter `model`
 * @returns 解析结果；未知值返回校验错误
 */
export function resolveSubagentModel(
  envModel: string | undefined,
  toolModel: string | undefined,
  definitionModel: string | undefined,
): SubagentModelResolution {
  const candidate = envModel ?? toolModel ?? definitionModel;
  if (candidate === undefined || candidate.trim() === '') {
    return { ok: true, resolved: { kind: 'inherit' } };
  }
  const model = candidate.trim();
  if (model === 'inherit') {
    return { ok: true, resolved: { kind: 'inherit' } };
  }
  // hasOwn 防止原型链属性（toString/constructor 等）被误识别为合法 profile ID。
  if (Object.hasOwn(BUILTIN_MODELS, model)) {
    return { ok: true, resolved: { kind: 'profile', profileId: model } };
  }
  return {
    ok: false,
    error: `未知的子代理模型: ${model}。可用值: ${availableSubagentModels().join(', ')}`,
  };
}
