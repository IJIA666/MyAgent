/**
 * 消息内容净化与日志占位符处理辅助工具。
 */

/**
 * 净化文本内容，将庞大的局部规则和技能全文替换为精简的占位符标记，用于日志记录和会话审计。
 * 
 * @param content - 原始的包含 XML 注入的文本内容
 * @returns 替换后的净化文本
 */
export function purifyContent(content: string): string {
  if (!content) return content;
  return content
    .replace(/<project_rules>[\s\S]*?<\/project_rules>/g, '<project_rules>[Rules Injected - Folded]</project_rules>')
    .replace(/<transient_skill>[\s\S]*?<\/transient_skill>/g, '<transient_skill>[Skill Injected - Folded]</transient_skill>')
    .replace(/\[SYSTEM NOTE:[\s\S]*?\]\n?/g, '')
    .replace(/\n?\[END OF SYSTEM NOTE\]/g, '')
    .trim();
}
