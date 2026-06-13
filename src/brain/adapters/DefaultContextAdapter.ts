import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import type { ContextAdapter } from './ContextAdapter.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * 默认上下文适配器实现类。
 * 负责在最新一条用户消息前挂载临时技能指令，并在会话头部注入历史摘要 Checkpoint 及核心文件记忆。
 */
export class DefaultContextAdapter implements ContextAdapter {
  /**
   * 组装会话历史、临时技能规范、局部项目规则、历史摘要与最近读写的文件。
   * 采用不可变原则，返回拷贝后的新消息数组，防止污染原始会话内存。
   *
   * @param baseHistory 会话的基础消息历史记录
   * @param transientContext 临时注入的技能规范内容
   * @param localRules 局部项目规则内容
   * @param summary 物理轮换产生的历史提炼摘要
   * @param recentFiles 剔除历史中大模型读写过的核心代码文件路径
   * @returns 拼接后的完整消息参数数组
   */
  public assemble(
    baseHistory: ChatCompletionMessageParam[],
    transientContext?: string,
    localRules?: string,
    summary?: string | null,
    recentFiles?: string[]
  ): ChatCompletionMessageParam[] {
    // 1. 浅拷贝基础消息数组，防止对数组的增删插操作污染原始引用
    const historySnapshot = [...baseHistory];

    // 1.1 组装并前置注入物理会话轮换的 Checkpoint 摘要与文件记忆附件
    const headInjections: ChatCompletionMessageParam[] = [];
    if (summary) {
      headInjections.push({
        role: 'user',
        content: `<conversation-checkpoint>\n${summary}\n</conversation-checkpoint>`
      });
    }
    if (recentFiles && recentFiles.length > 0) {
      for (const filePath of recentFiles) {
        try {
          const absolutePath = join(process.cwd(), filePath);
          if (existsSync(absolutePath)) {
            const fileContent = readFileSync(absolutePath, 'utf-8');
            headInjections.push({
              role: 'system',
              content: `<transient_file path="${filePath}">\n${fileContent}\n</transient_file>`
            });
          }
        } catch {
          // 容错处理：文件读取失败时不影响主上下文流程
        }
      }
    }
    // 时序追加至首条 System Prompt 之后以锁定头部前缀
    if (headInjections.length > 0) {
      if (historySnapshot.length > 0) {
        historySnapshot.splice(1, 0, ...headInjections);
      } else {
        historySnapshot.push(...headInjections);
      }
    }

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
