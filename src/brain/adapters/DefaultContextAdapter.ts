import type { ChatCompletionMessageParam, ChatCompletionUserMessageParam } from 'openai/resources/chat/completions.js';
import type { ContextAdapter } from './ContextAdapter.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { countTokens } from '../TokenEstimator.js';
import { HANDOFF_INSTRUCTION } from '../prompts.js';

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
        content: `<conversation-checkpoint>\n${summary}\n</conversation-checkpoint>\n\n${HANDOFF_INSTRUCTION}`
      });
    }

    let totalPinnedTokens = 0;
    const MAX_TOTAL_TOKENS = 25000;
    const MAX_SINGLE_TOKENS = 5000;

    if (recentFiles && recentFiles.length > 0) {
      for (const filePath of recentFiles) {
        if (totalPinnedTokens >= MAX_TOTAL_TOKENS) break;
        try {
          const absolutePath = join(process.cwd(), filePath);
          if (existsSync(absolutePath)) {
            let fileContent = readFileSync(absolutePath, 'utf-8');
            let fileTokens = countTokens(fileContent);

            if (fileTokens > MAX_SINGLE_TOKENS) {
              const ratio = MAX_SINGLE_TOKENS / fileTokens;
              const keepLen = Math.floor(fileContent.length * ratio / 2);
              fileContent = fileContent.substring(0, keepLen) + '\n...[内容过长，已被 Token 预算系统硬性截断]...\n' + fileContent.substring(fileContent.length - keepLen);
              fileTokens = MAX_SINGLE_TOKENS;
            }

            if (totalPinnedTokens + fileTokens > MAX_TOTAL_TOKENS) {
              continue;
            }

            totalPinnedTokens += fileTokens;
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
        // 4. 核心逻辑：安全地深拷贝最后一条 user 消息，防止污染 baseHistory 引用
        const originalUserMsg = historySnapshot[lastUserIndex];
        const copiedUserMsg = JSON.parse(JSON.stringify(originalUserMsg)) as ChatCompletionUserMessageParam;

        const originalContent = originalUserMsg.content;
        if (typeof originalContent === 'string') {
          copiedUserMsg.content = originalContent + injectedText;
        } else if (Array.isArray(originalContent)) {
          copiedUserMsg.content = [
            ...originalContent,
            { type: 'text', text: injectedText }
          ];
        } else {
          copiedUserMsg.content = injectedText.trim();
        }

        historySnapshot[lastUserIndex] = copiedUserMsg;
      }
    }

    return historySnapshot;
  }
}
