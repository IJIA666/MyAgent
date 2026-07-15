/**
 * 提供分 Shell 的有限状态结构扫描。
 * 只识别阶段 3 明确支持的顶层连接符，其他可执行结构一律标记为不支持。
 */

import type { ResolvedShellKind } from '../terminal-types.js';
import type {
  CommandConnector,
  CommandRiskSignal,
  ShellCommandParseStatus,
  ShellCommandShape,
} from './types.js';

/** 单个扫描片段。 */
export interface ScannedCommandSegment {
  /** 子命令文本。 */
  readonly command: string;
  /** 前置连接符。 */
  readonly connectorBefore?: CommandConnector;
}

/** Shell 结构扫描结果。 */
export interface ShellStructureScanResult {
  /** 解析状态。 */
  readonly parseStatus: ShellCommandParseStatus;
  /** 命令结构。 */
  readonly commandShape: ShellCommandShape;
  /** 已可靠拆分的子命令。 */
  readonly segments: readonly ScannedCommandSegment[];
  /** 结构风险。 */
  readonly riskSignals: readonly CommandRiskSignal[];
}

/** 扫描器配置。 */
export interface ShellStructureProfile {
  /** Shell family。 */
  readonly shellKind: ResolvedShellKind;
  /** 当前阶段允许的连接符。 */
  readonly allowedConnectors: readonly CommandConnector[];
}

const MAX_SUBCOMMANDS = 50;

/** 添加不重复的结构风险。 */
function addRisk(
  risks: CommandRiskSignal[],
  code: string,
  reason: string,
): void {
  if (!risks.some(risk => risk.code === code)) {
    risks.push({ code, reason });
  }
}

/** 判断连接符是否在当前 Shell 的支持集合中。 */
function isAllowedConnector(
  connector: CommandConnector,
  profile: ShellStructureProfile,
): boolean {
  return profile.allowedConnectors.includes(connector);
}

/**
 * 扫描 Shell 命令的顶层结构。
 *
 * @param command - 原始命令文本
 * @param profile - 当前 Shell 的有限语法配置
 * @returns 可靠拆分的子命令及支持状态
 */
export function scanShellCommandStructure(
  command: string,
  profile: ShellStructureProfile,
): ShellStructureScanResult {
  const segments: ScannedCommandSegment[] = [];
  const risks: CommandRiskSignal[] = [];
  let current = '';
  let connectorBefore: CommandConnector | undefined;
  let quote: 'single' | 'double' | null = null;
  let escaped = false;
  let invalid = command.trim().length === 0;
  let nested = false;

  // 显式启动第二层 Shell 会让引号内文本重新成为可执行语法，阶段 3 不做近似解包。
  const nestedShellPattern = /^(?:bash|sh)\b[^\r\n]*\s-c\s|^(?:powershell|pwsh)(?:\.exe)?\b[^\r\n]*\s(?:-c|-Command)\s|^cmd(?:\.exe)?\b[^\r\n]*\s\/[ck]\s/i;
  if (nestedShellPattern.test(command.trim())) {
    nested = true;
    addRisk(risks, 'structure.nested-shell', '当前阶段不支持嵌套 Shell 执行');
  }

  /** 提交一个由支持连接符分隔的原子片段。 */
  const pushSegment = (): void => {
    const trimmed = current.trim();
    if (trimmed.length === 0) {
      invalid = true;
      addRisk(risks, 'syntax.empty-segment', '复合命令包含空子命令');
      current = '';
      return;
    }
    segments.push({ command: trimmed, connectorBefore });
    current = '';
  };

  /** 处理支持的顶层连接符。 */
  const acceptConnector = (connector: CommandConnector): void => {
    pushSegment();
    connectorBefore = connector;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    const escapeCharacter = profile.shellKind === 'powershell' ? '`' : '\\';
    if (char === escapeCharacter && quote !== 'single') {
      current += char;
      escaped = true;
      continue;
    }

    if (quote === 'single') {
      current += char;
      if (char === "'") {
        quote = null;
      }
      continue;
    }

    if (quote === 'double') {
      current += char;
      if (char === '"') {
        quote = null;
        continue;
      }
      if (char === '$' && next === '(') {
        nested = true;
        addRisk(risks, 'structure.command-substitution', '双引号中包含命令替换');
      }
      if (profile.shellKind === 'posix' && char === '`') {
        nested = true;
        addRisk(risks, 'structure.backtick-substitution', '双引号中包含反引号命令替换');
      }
      continue;
    }

    if (char === "'") {
      quote = 'single';
      current += char;
      continue;
    }
    if (char === '"') {
      quote = 'double';
      current += char;
      continue;
    }

    if (char === '\r' || char === '\n') {
      current += char;
      addRisk(risks, 'structure.newline', '当前阶段不支持换行连接命令');
      continue;
    }

    if (char === '$' && next === '(') {
      nested = true;
      current += char;
      addRisk(risks, 'structure.command-substitution', '当前阶段不支持命令替换');
      continue;
    }

    if (profile.shellKind === 'posix' && char === '`') {
      nested = true;
      current += char;
      addRisk(risks, 'structure.backtick-substitution', '当前阶段不支持反引号命令替换');
      continue;
    }

    if (char === '(' || char === ')' || char === '{' || char === '}') {
      nested = true;
      current += char;
      addRisk(risks, 'structure.nested', '当前阶段不支持子 Shell、脚本块或控制流结构');
      continue;
    }

    if (char === '<' || char === '>') {
      current += char;
      addRisk(risks, 'structure.redirection', '当前阶段不支持输入或输出重定向');
      continue;
    }

    if (char === ';') {
      if (isAllowedConnector(';', profile)) {
        acceptConnector(';');
      } else {
        current += char;
      }
      continue;
    }

    if (char === '&') {
      if (next === '&') {
        if (isAllowedConnector('&&', profile)) {
          acceptConnector('&&');
        } else {
          current += '&&';
          addRisk(risks, 'structure.and-connector', '当前 Shell 暂不支持 && 连接符');
        }
        index += 1;
      } else if (isAllowedConnector('&', profile)) {
        acceptConnector('&');
      } else {
        current += char;
        addRisk(risks, 'structure.background', '当前阶段不支持后台执行或单 & 连接符');
      }
      continue;
    }

    if (char === '|') {
      if (next === '|') {
        if (isAllowedConnector('||', profile)) {
          acceptConnector('||');
        } else {
          current += '||';
          addRisk(risks, 'structure.or-connector', '当前 Shell 暂不支持 || 连接符');
        }
        index += 1;
      } else if (next === '&') {
        if (isAllowedConnector('|&', profile)) {
          acceptConnector('|&');
        } else {
          current += '|&';
          addRisk(risks, 'structure.pipeline', '当前阶段不支持标准错误管道');
        }
        index += 1;
      } else if (isAllowedConnector('|', profile)) {
        acceptConnector('|');
      } else {
        current += char;
        addRisk(risks, 'structure.pipeline', '当前阶段不支持管道');
      }
      continue;
    }

    current += char;
  }

  if (quote !== null || escaped) {
    invalid = true;
    addRisk(risks, 'syntax.unbalanced-quote', '命令包含不平衡的引号结构或结尾转义符');
  }

  pushSegment();

  if (segments.length > MAX_SUBCOMMANDS) {
    addRisk(risks, 'structure.too-many-subcommands', `复合命令超过 ${MAX_SUBCOMMANDS} 个子命令上限`);
  }

  const parseStatus: ShellCommandParseStatus = invalid
    ? 'invalid'
    : risks.length > 0 || segments.length > MAX_SUBCOMMANDS
      ? 'unsupported'
      : 'parsed';

  return {
    parseStatus,
    commandShape: nested ? 'nested' : segments.length > 1 ? 'compound' : 'atomic',
    segments,
    riskSignals: risks,
  };
}
