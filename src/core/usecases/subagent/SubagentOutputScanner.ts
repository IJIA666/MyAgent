/** 子代理交付文本的确定性扫描器，保留原文并只在交付副本上插入安全标记。 */
export class SubagentOutputScanner {
  /** 扫描器版本，写入 transcript 供后续诊断。 */
  public static readonly VERSION = 'subagent-output-scanner-v1';

  /**
   * 扫描最终交付文本。
   *
   * @param text - 子代理的原始 assistant 文本
   * @returns 交付副本、版本和命中规则 ID
   */
  public scan(text: string): SubagentScanResult {
    const ruleIds = new Set<string>();
    const output = text.split('\n').map(line => this.scanLine(line, ruleIds)).join('\n');
    return Object.freeze({
      text: output,
      version: SubagentOutputScanner.VERSION,
      ruleIds: Object.freeze(Array.from(ruleIds)),
    });
  }

  /** 对单行角色伪装、保留标签和权限绕过措辞执行幂等标记。 */
  private scanLine(line: string, ruleIds: Set<string>): string {
    if (line.startsWith('[subagent-safety:')) {
      // 重复扫描不再改写文本，同时恢复既有标记中的规则集合，保持结果完全幂等。
      const marker = /^\[subagent-safety:([^\]]+)\]/u.exec(line);
      marker?.[1].split('+').forEach(ruleId => ruleIds.add(ruleId));
      return line;
    }

    const lineRuleIds: string[] = [];
    let safeLine = line;
    const roleMatch = /^(\s*)(system|assistant|human|user|tool)\s*:/iu.exec(line);
    if (roleMatch) {
      const role = roleMatch[2].toLowerCase();
      const rest = line.slice(roleMatch[0].length);
      lineRuleIds.push('role-prefix');
      safeLine = `${roleMatch[1]}${role}\\: ${rest}`;
    }

    const reservedTagPattern = /(^|[^\\])(<\/?(?:system-reminder|system|assistant|human|user|tool)(?=[\s>/])|<<\/?sys>>|\[\/?system\])/giu;
    if (reservedTagPattern.test(line)) {
      lineRuleIds.push('reserved-tag');
      // 在每个尚未转义的保留标签首字符前加反斜杠，兼容标签位于行中以及 system-reminder 形态。
      safeLine = safeLine.replace(
        /(^|[^\\])(<\/?(?:system-reminder|system|assistant|human|user|tool)(?=[\s>/])|<<\/?sys>>|\[\/?system\])/giu,
        '$1\\$2',
      );
    }

    if (/(?:ignore|disregard)\s+(?:all\s+)?(?:previous|prior|above)\s+instructions|bypass\s+(?:all\s+)?permissions?|disable\s+safety|no\s+approval\s+required|do\s+not\s+ask\s+for\s+approval/iu.test(line)) {
      lineRuleIds.push('permission-bypass-language');
    }

    if (lineRuleIds.length === 0) {
      return line;
    }
    for (const ruleId of lineRuleIds) {
      ruleIds.add(ruleId);
    }
    return `[subagent-safety:${lineRuleIds.join('+')}] ${safeLine}`;
  }
}

/** 输出扫描结果。 */
export interface SubagentScanResult {
  /** 交付给父 Agent 的文本副本。 */
  readonly text: string;
  /** 扫描器版本。 */
  readonly version: string;
  /** 稳定规则 ID 集合。 */
  readonly ruleIds: readonly string[];
}
