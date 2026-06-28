import type { ChatMessage } from '../../ports/driven/llm/LlmPort.js';
import type { TokenEstimatorPort } from '../../ports/driven/llm/TokenEstimatorPort.js';
import type { ContextAdapter } from '../../ports/driven/session/ContextAdapter.js';
import { HANDOFF_INSTRUCTION } from '../../core/usecases/brain/prompts.js';
import type { StoredChatMessage } from '../../core/domain/context.js';

/**
 * 默认上下文适配器实现类。
 * 负责在最新一条用户消息前挂载临时技能指令，并在会话头部注入历史摘要 Checkpoint 及核心文件记忆。
 */
export class DefaultContextAdapter implements ContextAdapter {
  private tokenEstimator: TokenEstimatorPort;

  /**
   * 构造函数，注入分词预估器以解耦底层分词细节。
   *
   * @param tokenEstimator - Token 水位预估与计算适配 Port 接口
   */
  constructor(tokenEstimator: TokenEstimatorPort) {
    this.tokenEstimator = tokenEstimator;
  }

  /**
   * 组装会话历史、临时技能规范、局部项目规则、历史摘要与最近读写的文件。
   * 采用不可变原则，返回拷贝后的新消息数组，防止污染原始会话内存。
   *
   * @param baseHistory - 会话的基础消息历史记录
   * @param transientContext - 临时注入的技能规范内容
   * @param localRules - 局部项目规则内容
   * @param summary - 物理轮换产生的历史提炼摘要
   * @param recentFiles - 剔除历史中大模型读写过的核心代码文件路径
   * @returns 拼接后的完整消息参数数组
   */
  public assemble(
    baseHistory: ChatMessage[],
    transientContext?: string,
    localRules?: string,
    summary?: string | null,
    recentFiles?: { filePath: string; opType: 'read' | 'edit' }[]
  ): ChatMessage[] {
    // 1. 浅拷贝基础消息数组，防止对数组的增删插操作污染原始引用
    const historySnapshot = [...baseHistory];

    // 1.1 组装并前置注入物理会话轮换的 Checkpoint 摘要与文件记忆附件
    const headInjections: ChatMessage[] = [];
    
    // 构造 recentFiles 文本内容
    let inventoryText = '';
    if (recentFiles && recentFiles.length > 0) {
      const lines = recentFiles.map(fileItem => {
        const prefix = fileItem.opType === 'edit' ? '[EDITED]' : '[READ]';
        return `${prefix} ${fileItem.filePath}`;
      });
      inventoryText = `<recent_files_inventory>\n${lines.join('\n')}\n</recent_files_inventory>`;
    }

    if (summary) {
      let content = `<conversation-checkpoint>\n${summary}\n</conversation-checkpoint>\n\n${HANDOFF_INSTRUCTION}`;
      if (inventoryText) {
        content += `\n\n${inventoryText}`;
      }
      headInjections.push({
        role: 'user',
        content
      });
    } else if (inventoryText) {
      // 边界对齐：摘要不存在，但最近读写文件列表存在，为防 API 400，以独立 user 消息角色追加
      headInjections.push({
        role: 'user',
        content: inventoryText
      });
    }

    // 时序追加至首条 System Prompt 之后以锁定头部前缀
    if (headInjections.length > 0) {
      if (historySnapshot.length > 0) {
        historySnapshot.splice(1, 0, ...headInjections);
      } else {
        historySnapshot.push(...headInjections);
      }
    }

    // 2. 组装局部规则与临时技能，内嵌拼接在最新一条 user 消息的 content 中
    if (localRules || transientContext) {
      let injectedText = '\n\n[SYSTEM NOTE: The following project rules and transient skills are injected for this turn. You must strictly follow them.]';
      if (localRules) {
        injectedText += `\n<project_rules>\n${localRules}\n</project_rules>`;
      }
      if (transientContext) {
        injectedText += `\n<transient_skill>\n${transientContext}\n</transient_skill>`;
      }
      injectedText += '\n[END OF SYSTEM NOTE]';

      // 寻找最后一条 user 角色消息的位置
      let lastUserIndex = -1;
      for (let i = historySnapshot.length - 1; i >= 0; i--) {
        if (historySnapshot[i].role === 'user') {
          lastUserIndex = i;
          break;
        }
      }

      if (lastUserIndex === -1) {
        // 3. 边界兜底：如果没有找到 user 消息，则自动构建一条 user 消息追加到末尾并持久化
        historySnapshot.push({
          role: 'user',
          content: injectedText.trim()
        });
      } else {
        // 4. 核心逻辑：使用原生 structuredClone 内存拷贝最后一条 user 消息，防止污染 baseHistory 引用
        const originalUserMsg = historySnapshot[lastUserIndex];
        const copiedUserMsg = structuredClone(originalUserMsg) as ChatMessage;

        const originalContent = originalUserMsg.content;
        if (typeof originalContent === 'string') {
          copiedUserMsg.content = originalContent + injectedText;
        } else {
          copiedUserMsg.content = injectedText.trim();
        }

        historySnapshot[lastUserIndex] = copiedUserMsg;
      }
    }

    return historySnapshot.map(msg => {
      // 浅拷贝单条消息，防范物理 delete 污染 SessionContext 里的原始历史记录，并彻底消除 unused-vars 报错
      const cleanMsg = { ...msg } as StoredChatMessage;
      delete cleanMsg.originalPath;
      delete cleanMsg.isTruncated;
      return cleanMsg;
    });
  }
}
