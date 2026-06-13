import { describe, test, expect } from 'vitest';
import { purifyContent } from '../../src/utils/purify.js';
import { renderContentWithWidgets } from '../../src/interface/cli.js';

describe('净化与折叠微件渲染测试', () => {
  test('purifyContent 应当正确将冗长规则/技能替换为占位符，并剔除系统定界语', () => {
    const rawContent = `请帮我写个排序算法

[SYSTEM NOTE: The following project rules and transient skills are injected for this turn. You must strictly follow them.]
<project_rules>
规则 1: 必须使用 tabs 缩进。
规则 2: 不要写无用注释。
</project_rules>
<transient_skill>
技能 A: 提供 Word 读写能力。
</transient_skill>
[END OF SYSTEM NOTE]`;

    const result = purifyContent(rawContent);

    expect(result).toContain('请帮我写个排序算法');
    expect(result).not.toContain('[SYSTEM NOTE:');
    expect(result).not.toContain('[END OF SYSTEM NOTE]');
    expect(result).toContain('<project_rules>[Rules Injected - Folded]</project_rules>');
    expect(result).toContain('<transient_skill>[Skill Injected - Folded]</transient_skill>');
  });

  test('renderContentWithWidgets 应当正确生成终端折叠标签与文本排版', () => {
    const rawContent = `请帮我写个排序算法

[SYSTEM NOTE: The following project rules and transient skills are injected for this turn. You must strictly follow them.]
<project_rules>
规则 1: 必须使用 tabs 缩进。
</project_rules>
<transient_skill>
技能 A: 提供 Word 读写能力。
</transient_skill>
[END OF SYSTEM NOTE]`;

    const result = renderContentWithWidgets(rawContent);

    expect(result).toContain('请帮我写个排序算法');
    expect(result).not.toContain('[SYSTEM NOTE:');
    expect(result).not.toContain('<project_rules>');
    expect(result).not.toContain('<transient_skill>');
    expect(result).toContain('rules: project_rules');
    expect(result).toContain('skill: transient_skill');
    expect(result).toContain('已自动折叠锁定缓存');
  });
});
