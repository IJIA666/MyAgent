/**
 * @fileoverview 确定性大模型端口 Fake 实现，用于合约测试。
 * 返回预设的流式事件序列，不发起任何真实网络请求。
 */

import type { LlmPort, ChatMessage, LlmStreamEvent, LlmPortOptions } from '../../../src/ports/driven/llm/LlmPort.js';

/** 模拟模型名称常量 */
const FAKE_MODEL_NAME = 'fake-model-for-contract-test';

/**
 * 确定性 Fake LLM Port 实现。
 * 所有方法均返回预设值，不依赖真实 LLM 服务。
 */
export class FakeLlmPort implements LlmPort {
  /** 预设的流式事件序列，每次 streamChat 调用依次交付 */
  private presetEvents: LlmStreamEvent[];

  /**
   * 创建确定性模型端口。
   *
   * @param presetEvents - 可选的预设流式事件序列
   */
  constructor(presetEvents?: LlmStreamEvent[]) {
    this.presetEvents = presetEvents ?? [
      { type: 'thinking', content: 'mock thinking' },
      { type: 'content', content: 'mock content' },
      {
        type: 'complete',
        content: 'mock content',
        reasoning: 'mock thinking',
        assistantMessage: { role: 'assistant', content: 'mock content' },
      },
    ];
  }

  /** @returns 固定的 Fake 模型名称 */
  public getModelName(): string {
    return FAKE_MODEL_NAME;
  }

  /** 忽略模型切换请求，Fake 不连接真实服务。 */
  public switchModel(): void {
    // Fake 实现，不执行实际操作
  }

  /** 取消 Fake 请求；该实现没有真实请求需要终止。 */
  public abort(): void {
    // Fake 实现，不执行实际操作
  }

  /**
   * 返回预设的流式事件。
   *
   * @param _messages - 被忽略的消息历史
   * @param _tools - 被忽略的工具定义
   * @param _options - 被忽略的调用选项
   * @returns 确定性的异步事件生成器
   */
  public async *streamChat(
    _messages: ChatMessage[],
    _tools: Record<string, unknown>[],
    _options?: LlmPortOptions,
  ): AsyncGenerator<LlmStreamEvent, void, unknown> {
    for (const event of this.presetEvents) {
      yield event;
    }
  }

  /** @returns 固定的聊天响应 */
  public async chat(_messages: ChatMessage[], _options?: LlmPortOptions): Promise<string> {
    return 'fake chat response';
  }

  /** @returns 固定的摘要响应 */
  public async generateSummaryAsync(_messages: ChatMessage[]): Promise<string> {
    return 'fake summary';
  }
}
