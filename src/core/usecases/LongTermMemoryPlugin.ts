import * as fs from 'fs';
import * as path from 'path';
import type { HookContext, Plugin } from './plugin-types.js';
import { HookEventName } from './plugin-types.js';
import type { LlmPort, ChatMessage } from '../../ports/driven/LlmPort.js';

/**
 * 长期记忆自省与提炼插件。
 * 挂载于所有的核心生命周期节点，在会话结束时异步提炼有价值的知识和事实，并在模型推理前就地注入。
 */
export class LongTermMemoryPlugin implements Plugin {
  public readonly name = 'LongTermMemoryPlugin';
  public readonly weight = 50;

  private driver: LlmPort;
  private memoryFilePath: string;
  private onSessionEndCallback?: (history: ChatMessage[]) => void;
  private refinePromise: Promise<void> = Promise.resolve();

  /**
   * 构造函数。
   *
   * @param driver - 大语言模型驱动接口适配器实例
   * @param memoryFilePath - 可选。持久化长期记忆 file 路径，默认指向项目 .agent/MEMORY.md
   * @param onSessionEndCallback - 可选。会话结束后的异步自省提炼回调函数
   */
  constructor(
    driver: LlmPort,
    memoryFilePath?: string,
    onSessionEndCallback?: (history: ChatMessage[]) => void
  ) {
    this.driver = driver;
    this.onSessionEndCallback = onSessionEndCallback;
    /* eslint-disable-next-line n/no-process-env */
    const baseDir = process.env.AUTHORIZED_WORKSPACE_DIR || process.cwd();
    this.memoryFilePath = memoryFilePath || path.resolve(baseDir, '.agent/MEMORY.md');
  }

  public readonly hooks = {
    [HookEventName.BeforeModel]: async (context: HookContext, next: () => Promise<void>) => {
      await this.handleBeforeModel(context);
      await next();
    },
    [HookEventName.SessionEnd]: async (context: HookContext, next: () => Promise<void>) => {
      this.handleSessionEndAsync(context);
      await next();
    }
  };

  /**
   * 处理模型生成前的记忆召回与注入逻辑。
   *
   * @param context - 拦截执行的上下文对象
   */
  private async handleBeforeModel(context: HookContext): Promise<void> {
    if (!context.llmRequest || !context.llmRequest.messages) {
      return;
    }

    try {
      if (!fs.existsSync(this.memoryFilePath)) {
        return;
      }

      let memoryContent = await fs.promises.readFile(this.memoryFilePath, 'utf-8');
      memoryContent = memoryContent.trim();
      if (!memoryContent) {
        return;
      }

      if (memoryContent.length > 4000) {
        memoryContent = memoryContent.substring(memoryContent.length - 4000);
      }

      const memoryPrompt = `\n\n[长期记忆]\n${memoryContent}`;

      const systemMessage = context.llmRequest.messages.find(m => m.role === 'system');
      if (systemMessage) {
        systemMessage.content += memoryPrompt;
      } else {
        context.llmRequest.messages.unshift({
          role: 'system',
          content: memoryPrompt.trim()
        });
      }
    } catch (error) {
      console.error('[LongTermMemoryPlugin] 读取或注入长期记忆失败:', error);
    }
  }

  /**
   * 处理会话结束时的异步自省提炼。
   *
   * @param context - 拦截执行的上下文对象
   */
  private handleSessionEndAsync(context: HookContext): void {
    const history = context.sessionContext.getHistory();
    // 过滤掉 system 消息，计算真实对话轮数
    const effectiveHistory = history.filter(m => m.role !== 'system');
    if (!effectiveHistory || effectiveHistory.length < 2) {
      return;
    }

    if (this.onSessionEndCallback) {
      const callback = this.onSessionEndCallback;
      this.refinePromise = Promise.resolve().then(async () => {
        try {
          await callback(history);
        } catch (error) {
          console.error('[LongTermMemoryPlugin] 自省提炼回调触发失败:', error);
        }
      });
    }
  }
}
