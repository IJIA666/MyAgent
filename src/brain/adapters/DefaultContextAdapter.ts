import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import type { ContextAdapter } from './ContextAdapter.js';

/**
 * 默认上下文适配器实现类。
 * 负责在最新一条用户消息前挂载临时技能指令，并提供空历史兜底。
 */
export class DefaultContextAdapter implements ContextAdapter {
  /**
   * 组装会话历史与临时技能规范内容。
   * 采用不可变原则，返回拷贝后的新消息数组，避免污染原始会话内存。
   * 注入位置在最新的一条 user 消息之前，以保持 assistant(tool_calls) 与 tool 消息的相邻性，避免大模型协议错误。
   *
   * @param baseHistory 会话的基础消息历史记录
   * @param transientContext 临时注入的技能规范内容
   * @returns 拼接后的完整消息参数数组
   */
  public assemble(
    baseHistory: ChatCompletionMessageParam[],
    transientContext?: string
  ): ChatCompletionMessageParam[] {
    // 1. 浅拷贝基础消息数组，防止对数组的增删插操作污染原始引用（对象属性本身不修改，无需深拷贝对象）
    const historySnapshot = [...baseHistory];

    // 2. 如果没有临时上下文，直接返回拷贝后的历史数据
    if (!transientContext) {
      return historySnapshot;
    }

    // 3. 构建临时技能消息体
    const skillMessage: ChatCompletionMessageParam = {
      role: 'system',
      content: `<transient_skill>\n${transientContext}\n</transient_skill>`
    };

    // 4. 寻找最后一条 user 角色消息的位置
    let lastUserIndex = -1;
    for (let i = historySnapshot.length - 1; i >= 0; i--) {
      if (historySnapshot[i].role === 'user') {
        lastUserIndex = i;
        break;
      }
    }

    if (lastUserIndex === -1) {
      // 5. 边界兜底：如果没有找到 user 消息（例如会话刚启动且仅有 system 消息），则将临时技能直接追加到末尾
      historySnapshot.push(skillMessage);
    } else {
      // 6. 核心逻辑：插入到最后一条 user 消息之前
      historySnapshot.splice(lastUserIndex, 0, skillMessage);
    }

    return historySnapshot;
  }
}
