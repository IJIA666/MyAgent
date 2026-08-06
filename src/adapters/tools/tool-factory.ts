/**
 * @file tool-factory.ts
 * @description 本地内建工具的唯一装配工厂。
 * 将 LocalFileSystemMcpServer 中聚合 NativeTool[] 的逻辑抽取为独立导出函数，
 * 使 ToolRegistry 可直接引用统一装配源，消除双重装配问题。
 */

import { gitTools } from './impl/git/index.js';
import { fileSystemTools } from './impl/filesystem/index.js';
import { buildSystemTools } from './impl/system/index.js';
import { getSkillTools } from './impl/skill/index.js';
import { getInteractionTools } from './impl/interaction/index.js';
import { getBrowserTools } from './impl/browser/browser-tool-registry.js';
import { AgentTool } from './impl/agent/AgentTool.js';
import type { NativeTool } from './tool-types.js';
import type { ShellCompoundFeatureConfig } from './impl/system/command-analysis/index.js';
import type { SkillLibrary } from '../../core/usecases/brain/skill-library.js';
import type {
  SkillPendingStore,
  SkillWriteApprovalController,
} from '../../core/usecases/brain/skill-pending-store.js';
import type { SubagentExecutionPort } from '../../ports/driving/SubagentExecutionPort.js';
import { AGENT_TOOL_NAME } from './constants/native-tool-names.js';

/** 已完成 fresh 前台子代理安全审计的原生工具名；集合外工具默认不可见。 */
const FRESH_FOREGROUND_SUBAGENT_TOOLS = new Set<string>([
  'Bash',
  'PowerShell',
  'applyPatch',
  'browser_back',
  'browser_click',
  'browser_ensure_login',
  'browser_get_text',
  'browser_navigate',
  'browser_press',
  'browser_scroll',
  'browser_type',
  'browser_vision',
  'copyPath',
  'createDirectory',
  'deletePath',
  'editFile',
  'get_current_time',
  'gitShowDiff',
  'gitShowLog',
  'gitShowStatus',
  'globSearch',
  'grepSearch',
  'listFiles',
  'load_skill',
  'movePath',
  'readFile',
  'readManyFiles',
  'skill_manage',
  'skills_list',
  'writeFile',
]);

/** fresh 后台子代理的显式安全白名单；集合外工具默认保持关闭。 */
const FRESH_BACKGROUND_SUBAGENT_TOOLS = new Set<string>([
  'Bash',
  'PowerShell',
  'applyPatch',
  'editFile',
  'get_current_time',
  'gitShowDiff',
  'gitShowLog',
  'gitShowStatus',
  'globSearch',
  'grepSearch',
  'listFiles',
  'load_skill',
  'readFile',
  'readManyFiles',
  'skill_manage',
  'skills_list',
  'writeFile',
]);

/** buildNativeTools 的选项参数 */
export interface BuildNativeToolsOptions {
  /** 可选注入的共享 SkillLibrary（Skill 三工具统一数据源） */
  skillLibrary?: SkillLibrary;
  /** Skill 写入 pending 仓储。 */
  skillPendingStore?: SkillPendingStore;
  /** writeApproval 运行时开关。 */
  skillWriteApprovalController?: SkillWriteApprovalController;
  /** Shell 复合命令能力开关。 */
  shellCompoundFeatures?: Readonly<ShellCompoundFeatureConfig>;
  /** 主 Agent 使用的会话绑定子代理执行端口；未注入时 Agent 工具安全返回未绑定错误。 */
  subagentExecutionPort?: SubagentExecutionPort;
  /** 是否启用省略子代理类型即 exact-fork 的模型语义。 */
  subagentForkEnabled?: boolean;
}

/**
 * 装配所有本地内建工具实例。
 * 按照固定顺序（git → filesystem → system → skill → interaction → browser）聚合各领域模块的工具，
 * 返回统一的扁平 NativeTool[] 数组。
 *
 * @param options - 可选配置，如共享 SkillLibrary 与写入审批开关
 * @returns 所有领域工具实例的扁平数组
 */
export function buildNativeTools(options?: BuildNativeToolsOptions): NativeTool[] {
  const tools: NativeTool[] = [
    ...gitTools,
    ...fileSystemTools,
    ...buildSystemTools(options?.shellCompoundFeatures),
    ...getSkillTools(
      options?.skillLibrary,
      options?.skillPendingStore,
      options?.skillWriteApprovalController,
    ),
    ...getInteractionTools(),
    ...getBrowserTools(),
    new AgentTool(options?.subagentExecutionPort, options?.subagentForkEnabled ?? false),
  ];
  return tools.map(tool => withSubagentMetadata(tool, options?.subagentExecutionPort));
}

/** 为所有内建工具补齐已审计的子代理策略和总超时策略。 */
function withSubagentMetadata(
  tool: NativeTool,
  _subagentExecutionPort?: SubagentExecutionPort,
): NativeTool {
  if (tool.name === AGENT_TOOL_NAME) {
    return tool;
  }
  const existingPolicy = tool.subagentToolPolicy;
  // 必须在原实例上补元数据，保留 class prototype 上的 execute/checkPermissions 方法。
  Object.assign(tool, {
    subagentToolPolicy: Object.freeze({
      freshForeground: existingPolicy?.freshForeground === true
        || (existingPolicy === undefined && FRESH_FOREGROUND_SUBAGENT_TOOLS.has(tool.name)),
      freshBackground: existingPolicy?.freshBackground === true
        || (existingPolicy === undefined && FRESH_BACKGROUND_SUBAGENT_TOOLS.has(tool.name)),
      fork: existingPolicy?.fork === true,
    }),
    executionTimeoutPolicy: tool.executionTimeoutPolicy ?? 'standard',
  });
  return tool;
}
