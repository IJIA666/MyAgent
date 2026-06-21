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
  private writeQueue: Promise<void> = Promise.resolve();
  private refinePromise: Promise<void> = Promise.resolve();

  /**
   * 构造函数。
   *
   * @param driver - 大语言模型驱动接口适配器实例
   * @param memoryFilePath - 可选。持久化长期记忆 file 路径，默认指向项目 .agent/MEMORY.md
   */
  constructor(driver: LlmPort, memoryFilePath?: string) {
    this.driver = driver;
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

    this.refinePromise = Promise.resolve().then(async () => {
      try {
        await this.refineAndAppendMemory(history);
      } catch (error) {
        console.error('[LongTermMemoryPlugin] 异步长期记忆提炼失败:', error);
      }
    });
  }

  /**
   * 调用 LLM 进行长期记忆自省提炼，并将结果增量追加写入记忆文件。
   *
   * @param history - 会话历史消息数组
   */
  private async refineAndAppendMemory(history: ChatMessage[]): Promise<void> {
    const historyText = history
      .map(m => {
        let contentText = '';
        if (m.content !== null && m.content !== undefined) {
          if (typeof m.content === 'string') {
            contentText = m.content;
          } else {
            contentText = JSON.stringify(m.content);
          }
        }

        if (m.tool_calls && m.tool_calls.length > 0) {
          contentText += `\n[调用工具]: ${JSON.stringify(m.tool_calls)}`;
        }

        return `[${m.role}]: ${contentText}`;
      })
      .join('\n\n');

    const prompt = `您是一个长期记忆提炼助手。下面是当前会话的对话历史。请仔细阅读并提炼出对于未来开发有长期保留价值的事实、用户偏好或关键教训。

历史对话内容：
${historyText}

请遵循以下规则提炼：
1. 提炼结果应当精炼为要点列表，每条一个独立知识点，且条目之间空一行，总数不超过 5 条。
2. 每一个要点开头使用加粗的 4-6 个字总结核心主题作为视觉锚点，格式如：- **核心主题**：事实描述。
3. 英文前后空一格，始终使用简体中文。
4. 只返回提炼后的无序列表，不要包含任何前导词、总结词或 Markdown 代码块容器（如 \`\`\`markdown ）。`;

    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: prompt
      }
    ];

    let refinedText = '';
    try {
      const generator = this.driver.streamChat(messages, []);
      for await (const chunk of generator) {
        if (chunk.type === 'content') {
          refinedText += chunk.content;
        }
      }
    } catch (llmError) {
      console.error('[LongTermMemoryPlugin] 调用大模型进行提炼失败:', llmError);
      return;
    }

    refinedText = refinedText.trim();
    if (!refinedText) {
      return;
    }

    const appendText = `\n\n${refinedText}\n`;
    await this.queueWrite(appendText);
  }

  /**
   * 使用互斥队列将提炼记忆安全追加写入文件。
   *
   * @param text - 待追加写入的文本
   * @returns 互斥写入执行完毕的 Promise
   */
  private queueWrite(text: string): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const dir = path.dirname(this.memoryFilePath);
      if (!fs.existsSync(dir)) {
        await fs.promises.mkdir(dir, { recursive: true });
      }
      await fs.promises.appendFile(this.memoryFilePath, text, 'utf-8');
    }).catch(error => {
      console.error('[LongTermMemoryPlugin] 写入长期记忆文件发生错误:', error);
    });
    return this.writeQueue;
  }
}
