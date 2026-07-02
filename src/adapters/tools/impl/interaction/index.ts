/**
 * 人机交互类工具的统一导出入口。
 */

import { AskUserQuestionTool } from './ask-user-question.js';

export { AskUserQuestionTool } from './ask-user-question.js';

/**
 * 生成人机交互类原生工具实例列表。
 *
 * @returns 实例化的交互工具列表
 */
export function getInteractionTools() {
  return [
    new AskUserQuestionTool()
  ];
}
