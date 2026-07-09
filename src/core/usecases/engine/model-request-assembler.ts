import { runHookPipeline } from '../plugins/plugin-runner.js';
import { HookEventName, type LlmRequest } from '../plugins/plugin-types.js';
import type { ToolRegistryPort } from '../../../ports/driven/tools/ToolRegistryPort.js';
import type { ContextAdapter } from '../../../ports/driven/session/ContextAdapter.js';
import type { PluginRegistry } from '../plugins/plugin-registry.js';
import type { SessionContext, ContextTokenUsage } from '../../domain/context.js';
import type { ChatMessage } from '../../../ports/driven/llm/LlmPort.js';
import type { AgentEvent } from './agent-loop.js';

/**
 * 模型请求组装阶段产生的结果。
 */
export interface AssemblyResult {
  /** 最终组装好的消息数组（已注入 system-reminder 并完成 Plan 模式裁剪） */
  messages: ChatMessage[];
  /** 最终筛选/裁剪后的工具列表 */
  tools: Record<string, unknown>[];
  /** 控制流决策 */
  control: { action: 'continue' | 'abort' | 'restart'; reason?: string };
  /** 插件管线在执行期间产生的待发射事件 */
  events: AgentEvent[];
  /** 插件估算的 Token 用量（来自 BeforeModel 管线） */
  estimatedUsage?: ContextTokenUsage;
  /** BeforeModel 插件产生的 mock 响应（若插件直接模拟了 LLM 回包） */
  mockResponse?: unknown;
}

/**
 * 模型请求组装协作者。
 *
 * 收敛模型调用前的所有预处理逻辑，包括工具集获取、BeforeToolSelection 管线、
 * 上下文装配、BeforeModel 管线、system-reminder 注入与 Plan 模式工具裁剪。
 *
 * 该类在 `AgentLoop` 构造期实例化，与 `AgentLoop` 共享同一个 `SessionContext` 引用。
 */
export class ModelRequestAssembler {
  private toolRegistry: ToolRegistryPort;
  private contextAdapter: ContextAdapter;
  private ruleManager: { getLocalRules(): string | null };
  private pluginRegistry: PluginRegistry;
  private context: SessionContext;

  /**
   * @param toolRegistry - 工具注册端口，用于获取当前可用工具集
   * @param contextAdapter - 上下文适配器，用于组装历史消息与临时技能
   * @param ruleManager - 规则管理服务，提供局部规则
   * @param pluginRegistry - 插件注册管理器，用于获取各生命周期的 Hook 插件
   * @param context - 当前会话上下文
   */
  constructor(
    toolRegistry: ToolRegistryPort,
    contextAdapter: ContextAdapter,
    ruleManager: { getLocalRules(): string | null },
    pluginRegistry: PluginRegistry,
    context: SessionContext
  ) {
    this.toolRegistry = toolRegistry;
    this.contextAdapter = contextAdapter;
    this.ruleManager = ruleManager;
    this.pluginRegistry = pluginRegistry;
    this.context = context;
  }

  /**
   * 执行模型请求的完整组装流程。
   *
   * 严格遵循当前生产环境的执行顺序：
   * 1. `toolRegistry.getTools()` → 获取可用工具集
   * 2. `BeforeToolSelection` 管线 → 插件过滤/改写工具集
   * 3. `contextAdapter.assemble()` → 历史消息 + 临时技能 + 局部规则
   * 4. `BeforeModel` 管线 → 插件拦截/改写模型请求
   * 5. system-reminder 注入 → 日期/CWD/安全模式提醒
   * 6. Plan 模式工具裁剪 → 过滤 write 类工具
   *
   * @param transientSkillContent - 当前请求独占的临时技能规范内容
   * @param llmModel - 大模型名称，用于 BeforeModel 管线上下文中
   * @param emitEvent - 可选的事件发射回调，用于透传 BeforeToolSelection / BeforeModel 阶段的插件流式事件
   * @returns 组装结果，包含最终消息、工具列表、控制流状态与管线事件
   */
  public async assemble(
    transientSkillContent: string | undefined,
    llmModel: string,
    emitEvent?: (event: unknown) => void
  ): Promise<AssemblyResult> {
    const events: AgentEvent[] = [];

    // Step 1: 获取所有激活状态的工具集合
    const allTools = await this.toolRegistry.getTools();

    // Step 2: 触发 BeforeToolSelection 过滤并挑选工具
    const selectionResult = await runHookPipeline(
      HookEventName.BeforeToolSelection,
      this.context,
      this.pluginRegistry.getPluginsForEvent(HookEventName.BeforeToolSelection),
      { llmRequest: { tools: allTools } as LlmRequest, emitEvent }
    );

    if (selectionResult.control.action === 'abort') {
      return {
        messages: [], tools: [],
        control: { action: 'abort', reason: selectionResult.control.reason },
        events
      };
    }
    if (selectionResult.control.action === 'restart') {
      return {
        messages: [], tools: [],
        control: { action: 'restart', reason: selectionResult.control.reason },
        events
      };
    }

    const filteredTools = selectionResult.llmRequest?.tools ?? allTools;

    // Step 3: 委托上下文适配器进行历史记录的组装和临时技能的挂载
    const snapshotContext = this.contextAdapter.assemble(
      this.context.getHistory(),
      transientSkillContent,
      this.ruleManager.getLocalRules() || undefined,
      this.context.getCheckpointSummary(),
      this.context.getRecentFiles()
    );

    // Step 4: 触发 BeforeModel 拦截并重写大模型入参
    const beforeModelResult = await runHookPipeline(
      HookEventName.BeforeModel,
      this.context,
      this.pluginRegistry.getPluginsForEvent(HookEventName.BeforeModel),
      { llmRequest: { model: llmModel, messages: snapshotContext, tools: filteredTools } as LlmRequest, emitEvent }
    );

    if (beforeModelResult.control.action === 'abort') {
      return {
        messages: [], tools: [],
        control: { action: 'abort', reason: beforeModelResult.control.reason },
        events
      };
    }
    if (beforeModelResult.control.action === 'restart') {
      return {
        messages: [], tools: [],
        control: { action: 'restart', reason: beforeModelResult.control.reason },
        events
      };
    }

    const actualRequest = beforeModelResult.llmRequest ?? {
      model: llmModel,
      messages: snapshotContext,
      tools: filteredTools as Record<string, unknown>[]
    };

    // Step 5: system-reminder 注入
    const finalRequestMessages = [...(actualRequest.messages || [])];
    const currentMode = this.context.getWorkMode();

    let latestUserMessageIdx = -1;
    for (let i = finalRequestMessages.length - 1; i >= 0; i--) {
      if (finalRequestMessages[i].role === 'user') {
        latestUserMessageIdx = i;
        break;
      }
    }

    if (latestUserMessageIdx !== -1) {
      const userMsg = finalRequestMessages[latestUserMessageIdx];
      const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
      const cwdStr = process.cwd();
      const reminderBubble = `\n\n<system-reminder>\n[System Notification]\nDate: ${dateStr}\nCwd: ${cwdStr}\nSecurityMode: ${currentMode}\n</system-reminder>`;

      finalRequestMessages[latestUserMessageIdx] = {
        ...userMsg,
        content: (userMsg.content || '') + reminderBubble
      };

      // 动态挂载 systemReminder 属性到物理历史消息中，供落盘审计与调试可见
      const history = this.context.getHistory();
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role === 'user') {
          (history[i] as ChatMessage & { systemReminder?: string }).systemReminder = reminderBubble;
          break;
        }
      }
    }

    // Step 6: Plan 模式工具裁剪
    const enablePlanToolStripping = this.context.appConfig?.enablePlanToolStripping ?? false;
    let finalRequestTools = actualRequest.tools || [];
    if (enablePlanToolStripping && currentMode === 'Plan') {
      finalRequestTools = finalRequestTools.filter((t: unknown) => {
        return (t as { securityCategory?: string }).securityCategory !== 'write';
      });
    }

    return {
      messages: finalRequestMessages,
      tools: finalRequestTools,
      control: { action: 'continue' },
      events,
      estimatedUsage: beforeModelResult.estimatedUsage,
      mockResponse: beforeModelResult.llmResponse
    };
  }
}
