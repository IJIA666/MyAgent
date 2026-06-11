import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import type { ContextAdapter } from './ContextAdapter.js';

/**
 * 默认上下文适配器实现类。
 * 负责在最新一条用户消息前挂载临时技能指令，并提供空历史兜底。
 */
export class DefaultContextAdapter implements ContextAdapter {
  /**
   * 组装会话历史、临时技能规范与局部项目规则。
   * 采用不可变原则，返回拷贝后的新消息数组，防止污染原始会话内存。
   * 注入位置在最新的一条 user 消息之前，以保持 assistant(tool_calls) 与 tool 消息的相邻性，避免大模型协议错误。
   *
   * @param baseHistory 会话的基础消息历史记录
   * @param transientContext 临时注入的技能规范内容
   * @param localRules 局部项目规则内容
   * @returns 拼接后的完整消息参数数组
   */
  public assemble(
    baseHistory: ChatCompletionMessageParam[],
    transientContext?: string,
    localRules?: string
  ): ChatCompletionMessageParam[] {
    // 1. 浅拷贝基础消息数组，防止对数组的增删插操作污染原始引用
    const historySnapshot = [...baseHistory];

    // 2. 构建待注入的系统消息队列
    const messagesToInject: ChatCompletionMessageParam[] = [];

    // 3. 处理局部规则，如果存在则进行 XML 结构隔离包装
    if (localRules) {
      messagesToInject.push({
        role: 'system',
        content: `<project_rules>\n${localRules}\n</project_rules>`
      });
    }

    // 4. 处理临时技能上下文
    if (transientContext) {
      messagesToInject.push({
        role: 'system',
        content: `<transient_skill>\n${transientContext}\n</transient_skill>`
      });
    }

    // 5. 若无任何内容需要注入，直接返回历史快照
    if (messagesToInject.length === 0) {
      return historySnapshot;
    }

    // 6. 寻找最后一条 user 角色消息的位置
    let lastUserIndex = -1;
    for (let i = historySnapshot.length - 1; i >= 0; i--) {
      if (historySnapshot[i].role === 'user') {
        lastUserIndex = i;
        break;
      }
    }

    if (lastUserIndex === -1) {
      // 7. 边界兜底：如果没有找到 user 消息，则将注入消息追加到末尾
      historySnapshot.push(...messagesToInject);
    } else {
      // 8. 核心逻辑：安全地批量插入到最后一条 user 消息之前
      historySnapshot.splice(lastUserIndex, 0, ...messagesToInject);
    }

    return historySnapshot;
  }
}
