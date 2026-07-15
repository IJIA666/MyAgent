import type { ChatMessage } from '../../ports/driven/llm/LlmPort.js';
import type { TokenEstimatorPort } from '../../ports/driven/llm/TokenEstimatorPort.js';
import type { ContextAdapter } from '../../ports/driven/session/ContextAdapter.js';
import type { StoredChatMessage } from '../../core/domain/context.js';

/**
 * 默认上下文适配器实现类。
 * 负责在最新一条用户消息中挂载局部规则与临时技能指令。
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
   * 组装会话历史、临时技能规范与局部项目规则。
   * 采用不可变原则，返回拷贝后的新消息数组，防止污染原始会话内存。
   *
   * @param baseHistory - 会话的基础消息历史记录
   * @param transientContext - 临时注入的技能规范内容
   * @param localRules - 局部项目规则内容
   * @returns 拼接后的完整消息参数数组
   */
  public assemble(
    baseHistory: ChatMessage[],
    transientContext?: string,
    localRules?: string
  ): ChatMessage[] {
    // 1. 浅拷贝基础消息数组，防止对数组的增删插操作污染原始引用
    const historySnapshot = [...baseHistory];

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
