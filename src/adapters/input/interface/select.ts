/**
 * @file 单选菜单适配层。
 * 统一封装 CLI 单选交互，复用 Clack 的导航与布局能力，同时修正取消态误导性的删除线渲染。
 */

import { SelectPrompt, settings, type State, wrapTextWithPrefix } from '@clack/core';
import {
  formatInstructionFooter,
  limitOptions,
  type Option,
  type SelectOptions,
  SELECT_INSTRUCTIONS,
  S_BAR,
  S_RADIO_ACTIVE,
  S_RADIO_INACTIVE,
  symbol,
  symbolBar
} from '@clack/prompts';
import { styleText } from 'node:util';

const CANCEL_SUMMARY = styleText('dim', '已取消');

type SelectRenderMode = 'disabled' | 'selected' | 'active' | 'inactive';

/**
 * 渲染单选菜单当前帧。
 *
 * @param options - 单选菜单的原始参数
 * @param frame - 当前提示器帧状态
 * @returns 可直接写入终端的当前帧文本
 */
export function renderSingleSelectFrame<Value>(
  options: SelectOptions<Value>,
  frame: { state: State; cursor: number; options: Option<Value>[] }
): string {
  const withGuide = options.withGuide ?? settings.withGuide;
  const messagePrefix = `${symbol(frame.state)}  `;
  const barPrefix = `${symbolBar(frame.state)}  `;
  const wrappedMessage = wrapTextWithPrefix(
    options.output,
    options.message,
    barPrefix,
    messagePrefix
  );
  const promptHeader = `${withGuide ? `${styleText('gray', S_BAR)}\n` : ''}${wrappedMessage}\n`;

  if (frame.state === 'submit') {
    const submitPrefix = withGuide ? `${styleText('gray', S_BAR)}  ` : '';
    const selectedLine = wrapTextWithPrefix(
      options.output,
      renderSelectOption(frame.options[frame.cursor], 'selected'),
      submitPrefix
    );
    return `${promptHeader}${selectedLine}`;
  }

  if (frame.state === 'cancel') {
    const cancelPrefix = withGuide ? `${styleText('gray', S_BAR)}  ` : '';
    const cancelLine = wrapTextWithPrefix(options.output, CANCEL_SUMMARY, cancelPrefix);
    return `${promptHeader}${cancelLine}${withGuide ? `\n${styleText('gray', S_BAR)}` : ''}`;
  }

  const optionPrefix = withGuide ? `${styleText('cyan', S_BAR)}  ` : '';
  const headerRows = promptHeader.split('\n').length;
  const footerLines = formatInstructionFooter(SELECT_INSTRUCTIONS, withGuide);
  const footerText = footerLines.join('\n');
  const footerRows = footerLines.length + 1;
  const visibleOptions = limitOptions({
    output: options.output,
    cursor: frame.cursor,
    options: frame.options,
    maxItems: options.maxItems,
    columnPadding: optionPrefix.length,
    rowPadding: headerRows + footerRows,
    style: (option, active) =>
      renderSelectOption(option, option.disabled ? 'disabled' : active ? 'active' : 'inactive')
  }).join(`\n${optionPrefix}`);

  return `${promptHeader}${optionPrefix}${visibleOptions}\n${footerText}\n`;
}

/**
 * 展示单选菜单，并在取消时输出中性结果而不是删除线选项。
 *
 * @param options - 单选菜单参数
 * @returns 用户选择结果，若取消则返回 Clack 取消符号
 */
export async function selectWithCleanCancel<Value>(options: SelectOptions<Value>): Promise<Value | symbol> {
  const result = await new SelectPrompt({
    options: options.options,
    signal: options.signal,
    input: options.input,
    output: options.output,
    initialValue: options.initialValue,
    render() {
      return renderSingleSelectFrame(options, {
        state: this.state,
        cursor: this.cursor,
        options: this.options
      });
    }
  }).prompt();
  return result as Value | symbol;
}

/**
 * 统一格式化单选项文本。
 */
function renderSelectOption<Value>(option: Option<Value>, mode: SelectRenderMode): string {
  const label = option.label ?? String(option.value);
  switch (mode) {
    case 'disabled':
      return `${styleText('gray', S_RADIO_INACTIVE)} ${mapMultiline(label, (line) => styleText('gray', line))}${option.hint ? ` ${styleText('dim', `(${option.hint ?? 'disabled'})`)}` : ''}`;
    case 'selected':
      return mapMultiline(label, (line) => styleText('dim', line));
    case 'active':
      return `${styleText('green', S_RADIO_ACTIVE)} ${label}${option.hint ? ` ${styleText('dim', `(${option.hint})`)}` : ''}`;
    default:
      return `${styleText('dim', S_RADIO_INACTIVE)} ${mapMultiline(label, (line) => styleText('dim', line))}`;
  }
}

/**
 * 保持多行标签逐行套用样式，避免换行后颜色丢失。
 */
function mapMultiline(text: string, formatter: (line: string) => string): string {
  if (!text.includes('\n')) {
    return formatter(text);
  }
  return text.split('\n').map((line) => formatter(line)).join('\n');
}
