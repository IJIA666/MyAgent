/**
 * @file 代码修补辅助块替换算法模块。
 * 核心职责：提供基于期望行签名与滑动窗口搜索的代码精确定位与替换逻辑，以规避行号漂移。
 */

/**
 * 块替换参数定义。
 */
export interface ReplacePatchOptions {
  /** 目标文件当前的完整文本内容 */
  fileContent: string;
  /** 要替换进去的新代码片段 */
  patchContent: string;
  /** 期望的原文特征上下文签名，前导和尾随空格会被忽略 */
  expectedContent: string;
  /** 期望匹配代码块的大致起始行号（可选，从 1 开始） */
  startLine?: number;
  /** 期望匹配代码块的大致结束行号（可选，从 1 开始） */
  endLine?: number;
}

/**
 * 通过滑动窗口匹配期望行特征，并在匹配到的唯一位置上用新内容替换。
 *
 * @param options - 块替换选项参数
 * @returns 包含替换后的完整内容以及替换起点的结果对象
 * @throws 匹配不到或匹配到多处特征时抛出异常
 */
export function applyReplacePatch(options: ReplacePatchOptions): { newContent: string; matchedLine: number; matchedLinesCount: number } {
  const { fileContent, patchContent, expectedContent, startLine, endLine } = options;

  if (!expectedContent.trim()) {
    throw new Error("在 'replace' 模式下，必须提供有意义的 expectedContent 期望原文行特征签名。");
  }

  const fileLines = fileContent.split(/\r?\n/);
  const totalLines = fileLines.length;

  const start = typeof startLine === 'number' ? Math.max(1, startLine) : 1;
  const end = typeof endLine === 'number' ? Math.min(totalLines, endLine) : totalLines;

  // 在行号 [start, end] 的邻域（上下 50 行）进行特征查找以抵抗漂移
  const searchStart = Math.max(1, start - 50);
  const searchEnd = Math.min(totalLines, end + 50);

  const expectedLines = expectedContent.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (expectedLines.length === 0) {
    throw new Error("expectedContent 不能全为空格或空行。");
  }

  const matchIndices: number[] = [];
  const N = expectedLines.length;

  // 在搜索行号范围内滑动匹配特征行签名（忽略前导和尾随空格）
  for (let i = searchStart - 1; i <= searchEnd - N; i++) {
    let isMatch = true;
    for (let j = 0; j < N; j++) {
      if (fileLines[i + j].trim() !== expectedLines[j]) {
        isMatch = false;
        break;
      }
    }
    if (isMatch) {
      matchIndices.push(i);
    }
  }

  if (matchIndices.length === 0) {
    throw new Error(`在搜寻行号范围 [${searchStart}, ${searchEnd}] 内，未匹配到 expectedContent 的特征签名行。请提供更多正确的原文特征或拓宽 startLine/endLine 检索边界。`);
  }

  if (matchIndices.length > 1) {
    throw new Error(`在搜寻行号范围 [${searchStart}, ${searchEnd}] 内，匹配到了多于 1 处 (${matchIndices.length} 处) 的 expectedContent 特征，位置无法唯一对齐。请提供更长的唯一上下文签名，或者收紧 startLine/endLine 检索边界。`);
  }

  const targetIndex = matchIndices[0];
  const newContentLines = [
    ...fileLines.slice(0, targetIndex),
    patchContent,
    ...fileLines.slice(targetIndex + N)
  ];

  return {
    newContent: newContentLines.join('\n'),
    matchedLine: targetIndex + 1,
    matchedLinesCount: N
  };
}
