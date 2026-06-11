import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';

/**
 * 上下文适配器接口。
 * 负责大模型上下文消息的组装、缓存优化与管理，将上下文拼接逻辑与 Session 主控制流解耦。
 */
export interface ContextAdapter {
  /**
   * 组装会话历史、临时上下文与局部规则。
   * 必须保证返回的是一个深拷贝后的新数组快照，避免污染基线 SessionContext 的原有状态。
   *
   * @param baseHistory 会话的基础消息历史记录
   * @param transientContext 临时需要注入的技能或上下文文本内容
   * @param localRules 项目局部的外部规则文件内容，可选参数
   * @returns 组装好的、可直接发送给大模型的完整消息参数数组
   */
  assemble(
    baseHistory: ChatCompletionMessageParam[],
    transientContext?: string,
    localRules?: string
  ): ChatCompletionMessageParam[];
}
