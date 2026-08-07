/**
 * @file 最小 CLI 参数解析。
 * 当前仅支持 `--agent <type>`；未知 flag 一律忽略保持向后兼容。
 */

/**
 * 提取 `--agent <type>` 的值。
 *
 * @param argv - 进程参数数组
 * @returns 子代理类型名；未提供时返回 undefined
 */
export function parseAgentCliArg(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length - 1; index++) {
    if (argv[index] === '--agent') {
      const value = argv[index + 1]?.trim();
      return value || undefined;
    }
  }
  return undefined;
}
