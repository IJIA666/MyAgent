import type { HookContext, Plugin } from './plugin-types.js';
import { HookEventName } from './plugin-types.js';
import type { ToolDispatcher } from '../services/ToolDispatcher.js';

/**
 * JIT 规则注入插件。
 * 挂载在 SessionStart 与 AfterTool，捕获文件读取 (readFile) 后的 JIT 伴生规则，
 * 并将其追加到最近一条 user 消息尾部，从而利用并保护大模型的 Prompt Cache。
 */
export class JitRulesPlugin implements Plugin {
  public readonly name = 'JitRulesPlugin';
  public readonly weight = 20;

  private toolDispatcher: ToolDispatcher;
  private injectedJitPaths = new Set<string>();

  /**
   * 构造函数。
   *
   * @param toolDispatcher - 工具分发与处理服务实例
   */
  constructor(toolDispatcher: ToolDispatcher) {
    this.toolDispatcher = toolDispatcher;
  }

  public readonly hooks = {
    [HookEventName.SessionStart]: async (context: HookContext, next: () => Promise<void>) => {
      this.injectedJitPaths.clear();
      await next();
    },
    [HookEventName.AfterTool]: async (context: HookContext, next: () => Promise<void>) => {
      const toolCall = context.toolCall;
      if (
        toolCall?.name === 'readFile' &&
        context.toolResult &&
        !context.toolResult.isError &&
        typeof toolCall.arguments?.targetPath === 'string'
      ) {
        const filePath = toolCall.arguments.targetPath;
        const jitText = this.toolDispatcher.resolveJitContext(filePath, this.injectedJitPaths);
        if (jitText) {
          const history = context.sessionContext.getHistory();
          // 从后往前寻找最近的一条 user 消息
          for (let i = history.length - 1; i >= 0; i--) {
            const msg = history[i];
            if (msg.role === 'user' && typeof msg.content === 'string') {
              msg.content += `\n\n${jitText}`;
              break;
            }
          }
        }
      }
      await next();
    }
  };
}
