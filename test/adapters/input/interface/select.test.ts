import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { renderSingleSelectFrame } from '../../../../src/adapters/input/interface/select.js';

/**
 * 构造具备 TTY 能力的输出流，供 Clack 布局计算使用。
 */
function createMockOutput(): PassThrough {
  const output = new PassThrough();
  (output as unknown as { isTTY: boolean }).isTTY = true;
  (output as unknown as { columns: number }).columns = 120;
  (output as unknown as { rows: number }).rows = 40;
  return output;
}

/**
 * 移除 ANSI 控制符，便于稳定断言文本内容。
 */
function stripAnsi(text: string): string {
  const esc1 = String.fromCharCode(0x1b);
  const esc2 = String.fromCharCode(0x9b);
  const pattern = `[${esc1}${esc2}][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`;
  return text.replace(new RegExp(pattern, 'g'), '');
}

describe('renderSingleSelectFrame', () => {
  it('取消态应当输出中性的已取消结果，而不是删除线焦点选项', () => {
    const output = createMockOutput();
    const frame = renderSingleSelectFrame(
      {
        message: '请选择目标模型:',
        options: [
          { value: 'gpt-5', label: 'GPT-5' },
          { value: 'gpt-4.1', label: 'GPT-4.1' }
        ],
        output
      },
      {
        state: 'cancel',
        cursor: 1,
        options: [
          { value: 'gpt-5', label: 'GPT-5' },
          { value: 'gpt-4.1', label: 'GPT-4.1' }
        ]
      }
    );

    const plainText = stripAnsi(frame);
    expect(plainText).toContain('请选择目标模型:');
    expect(plainText).toContain('已取消');
    expect(plainText).not.toContain('GPT-4.1');
  });

  it('提交态应当继续回显已选中的选项文本', () => {
    const output = createMockOutput();
    const frame = renderSingleSelectFrame(
      {
        message: '请选择安全模式:',
        options: [
          { value: 'Auto', label: 'Auto' },
          { value: 'Plan', label: 'Plan' }
        ],
        output
      },
      {
        state: 'submit',
        cursor: 1,
        options: [
          { value: 'Auto', label: 'Auto' },
          { value: 'Plan', label: 'Plan' }
        ]
      }
    );

    const plainText = stripAnsi(frame);
    expect(plainText).toContain('请选择安全模式:');
    expect(plainText).toContain('Plan');
    expect(plainText).not.toContain('已取消');
  });
});
