/**
 * @file 批量文件读取辅助大纲分析算法模块。
 * 核心职责：提供针对代码文件的轻量大纲分析以及大文件首尾片段降级提取逻辑。
 */

/**
 * 降级提取首尾各 20 行文本。
 *
 * @param lines - 文件所有行
 * @returns 首尾行拼接成的摘要内容
 */
export function getFallbackSnippet(lines: string[]): string {
  const total = lines.length;
  if (total <= 40) {
    return lines.join('\n');
  }
  const head = lines.slice(0, 20).join('\n');
  const tail = lines.slice(-20).join('\n');
  return `[前 20 行]\n${head}\n...\n[后 20 行]\n${tail}`;
}

/**
 * 提取文件内容大纲摘要。
 *
 * @param relativePath - 文件相对路径
 * @param content - 文件完整文本内容
 * @returns 包含大纲类型和内容的结果对象
 */
export function extractFileOutline(
  relativePath: string,
  content: string
): { outlineType: 'regex_outline' | 'fallback_snippet'; outline: string } {
  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;

  const ext = relativePath.split('.').pop()?.toLowerCase();
  const isCodeExt = ['ts', 'tsx', 'js', 'jsx', 'py', 'java', 'go', 'c', 'cpp', 'h', 'cs', 'rb', 'php', 'rs'].includes(ext || '');

  if (isCodeExt) {
    const matchedLines: string[] = [];
    const codeKeywords = /^\s*(export\s+)?(class|interface|function|const|let|var|async\s+function|export\s+default)\b/;
    
    for (let i = 0; i < totalLines; i++) {
      const line = lines[i];
      if (codeKeywords.test(line)) {
        matchedLines.push(`L${i + 1}: ${line.trim()}`);
      }
    }

    if (matchedLines.length > 0) {
      let outlineContent = matchedLines.slice(0, 100).join('\n');
      if (matchedLines.length > 100) {
        outlineContent += `\n... (省略余下 ${matchedLines.length - 100} 个匹配项)`;
      }
      return {
        outlineType: 'regex_outline',
        outline: outlineContent
      };
    }
  }

  // 非代码或未匹配到关键字时，降级首尾 20 行
  return {
    outlineType: 'fallback_snippet',
    outline: getFallbackSnippet(lines)
  };
}
