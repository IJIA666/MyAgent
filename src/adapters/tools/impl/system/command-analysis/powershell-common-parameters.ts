/**
 * 维护 PowerShell 通用参数及参数名称的稳定规范化规则。
 * 所有 PowerShell 命令规则必须通过本模块处理参数名，避免横线字符和冒号绑定造成漂移。
 */

/** PowerShell 可用于参数前缀的 Unicode 横线字符。 */
const POWERSHELL_DASH_PATTERN = /^[\u002d\u2010\u2011\u2012\u2013\u2014\u2015\u2212\ufe58\ufe63\uff0d]/u;

/** 无需独立参数值的通用开关。 */
export const POWERSHELL_COMMON_SWITCHES: ReadonlySet<string> = new Set([
  '-debug',
  '-verbose',
]);

/** 后续元素或冒号后文本作为参数值的通用参数。 */
export const POWERSHELL_COMMON_VALUE_PARAMETERS: ReadonlySet<string> = new Set([
  '-erroraction',
  '-errorvariable',
  '-informationaction',
  '-informationvariable',
  '-outbuffer',
  '-outvariable',
  '-pipelinevariable',
  '-progressaction',
  '-warningaction',
  '-warningvariable',
]);

/** 全部 PowerShell 通用参数。 */
export const POWERSHELL_COMMON_PARAMETERS: ReadonlySet<string> = new Set([
  ...POWERSHELL_COMMON_SWITCHES,
  ...POWERSHELL_COMMON_VALUE_PARAMETERS,
]);

/**
 * 规范参数名称，保留统一的 ASCII 横线并移除冒号或等号绑定值。
 *
 * @param rawParameter - 原始参数文本
 * @returns 小写规范参数名；输入不是参数时返回 undefined
 */
export function normalizePowerShellParameterName(rawParameter: string): string | undefined {
  if (!POWERSHELL_DASH_PATTERN.test(rawParameter)) {
    return undefined;
  }
  const ascii = `-${rawParameter.slice(1)}`;
  const separatorIndexes = [ascii.indexOf(':'), ascii.indexOf('=')]
    .filter(index => index > 0);
  const end = separatorIndexes.length > 0 ? Math.min(...separatorIndexes) : ascii.length;
  return ascii.slice(0, end).toLowerCase();
}

/**
 * 判断参数是否在当前命令配置或 PowerShell 通用参数中。
 *
 * @param rawParameter - 原始参数文本
 * @param commandParameters - 命令自身允许的参数集合
 * @returns 参数是否已被规则覆盖
 */
export function isKnownPowerShellParameter(
  rawParameter: string,
  commandParameters: ReadonlySet<string>,
): boolean {
  const normalized = normalizePowerShellParameterName(rawParameter);
  return normalized !== undefined && (
    POWERSHELL_COMMON_PARAMETERS.has(normalized) || commandParameters.has(normalized)
  );
}
