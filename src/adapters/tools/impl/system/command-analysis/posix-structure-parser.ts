/**
 * POSIX Shell 的结构化词法解析入口。
 * 使用 shell-quote 识别引号边界和控制操作符，但不展开运行时环境变量。
 */

import { parse } from 'shell-quote';
import type {
  CommandConnector,
  CommandRedirectionAnalysis,
  CommandRiskSignal,
  ShellCommandSyntaxNode,
  ShellStructureParseResult,
} from './types.js';

const MAX_COMMAND_NODES = 50;
const CONNECTORS = new Map<string, CommandConnector>([
  [';', ';'],
  ['&&', '&&'],
  ['||', '||'],
  ['|', '|'],
  ['|&', '|&'],
  ['&', '&'],
]);
const REDIRECTION_OPERATORS = new Set(['<', '>', '>>', '<&', '>&', '<<<']);

/** 检查 POSIX 引号是否完整闭合，不参与 token 或权限判断。 */
function findUnclosedQuote(command: string): "'" | '"' | '`' | undefined {
  let quote: "'" | '"' | '`' | undefined;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
    }
  }
  return quote;
}

/** 检测是否为反引号包裹的命令替换字符串。 */
function isBacktickSubstitution(text: string): boolean {
  return text.startsWith('`') && text.endsWith('`') && text.length >= 2;
}

/** 将 shell-quote 的非字符串 token 转换为稳定文本。 */
function tokenText(token: object): string | undefined {
  if ('pattern' in token && typeof token.pattern === 'string') {
    return token.pattern;
  }
  return undefined;
}

/** 创建尚未完成权限归类的重定向证据。 */
function createRedirection(operator: string, target?: string): CommandRedirectionAnalysis {
  const isInput = operator.startsWith('<') && operator !== '<<<';
  return {
    operator,
    target,
    sideEffect: isInput ? 'sensitive-read' : 'write',
    permission: 'ask',
    reason: target ? `检测到重定向 ${operator} ${target}` : `重定向 ${operator} 缺少静态目标`,
  };
}

/**
 * 解析 POSIX Shell 命令的结构化词法节点。
 *
 * @param command - 原始 Bash/POSIX 命令文本
 * @param enableNested - 是否启用嵌套结构解析（子 Shell、命令替换）
 * @returns 不依赖进程环境的结构化解析结果
 */
export function parsePosixStructure(command: string, enableNested: boolean = false): ShellStructureParseResult {
  const risks: CommandRiskSignal[] = [];
  const unclosedQuote = findUnclosedQuote(command);
  if (unclosedQuote) {
    return {
      parseStatus: 'invalid',
      nodes: [],
      riskSignals: [{
        code: 'parser.posix-unclosed-quote',
        reason: `POSIX 命令包含未闭合的 ${unclosedQuote} 引号`,
      }],
    };
  }
  let tokens: ReturnType<typeof parse>;
  try {
    // 返回原样变量占位，禁止解析器读取当前进程环境。
    tokens = parse(command, variable => `$${variable}`);
  } catch (error) {
    return {
      parseStatus: 'invalid',
      nodes: [],
      riskSignals: [{
        code: 'parser.posix-invalid',
        reason: error instanceof Error ? error.message : 'POSIX 命令语法无效',
      }],
    };
  }

  const nodes: ShellCommandSyntaxNode[] = [];
  let words: string[] = [];
  let redirections: CommandRedirectionAnalysis[] = [];
  let pendingRedirection: string | undefined;
  let connectorBefore: CommandConnector | undefined;
  let pipelineIndex = 0;
  let unsupported = false;

  /** 将当前 token 组固定为一个命令节点。 */
  const flushNode = (): void => {
    if (pendingRedirection) {
      redirections.push(createRedirection(pendingRedirection));
      pendingRedirection = undefined;
      unsupported = true;
      risks.push({ code: 'parser.redirection-target-missing', reason: '重定向缺少静态目标' });
    }
    if (words.length === 0) {
      return;
    }
    nodes.push({
      command: words.join(' '),
      nodePath: [nodes.length],
      connectorBefore,
      pipelineIndex,
      background: connectorBefore === '&' ? true : undefined,
      redirections,
    });
    words = [];
    redirections = [];
  };

  for (const token of tokens) {
    if (typeof token === 'string') {
      if (pendingRedirection) {
        redirections.push(createRedirection(pendingRedirection, token));
        pendingRedirection = undefined;
      } else {
        words.push(token);
        // 反引号包裹的命令替换由 shell-quote 返回为单个字符串
        if (isBacktickSubstitution(token) && !enableNested) {
          unsupported = true;
          risks.push({ code: 'structure.backtick-substitution', reason: '检测到反引号命令替换嵌套' });
        }
      }
      continue;
    }
    const text = tokenText(token);
    if (text !== undefined) {
      if (pendingRedirection) {
        redirections.push(createRedirection(pendingRedirection, text));
        pendingRedirection = undefined;
      } else {
        words.push(text);
      }
      continue;
    }
    if (!('op' in token) || typeof token.op !== 'string') {
      continue;
    }
    if (REDIRECTION_OPERATORS.has(token.op)) {
      if (pendingRedirection) {
        unsupported = true;
        risks.push({ code: 'parser.redirection-chain-invalid', reason: '连续重定向操作符缺少目标' });
      }
      pendingRedirection = token.op;
      continue;
    }
    // shell-quote 将 (){} 解析为 op token（类型声明未覆盖，使用宽化类型比较）
    const rawOp = token.op as string;
    if (rawOp === '(' || rawOp === ')' || rawOp === '{' || rawOp === '}') {
      // 子 Shell、命令分组、命令替换内的括号——保留在命令文本中作为嵌套标记
      words.push(rawOp);
      if (!enableNested) {
        unsupported = true;
        risks.push({ code: 'structure.nested-posix', reason: `检测到 POSIX 嵌套结构标记 ${token.op}` });
      }
      continue;
    }
    const connector = CONNECTORS.get(token.op);
    if (connector) {
      flushNode();
      connectorBefore = connector;
      pipelineIndex = connector === '|' || connector === '|&' ? pipelineIndex + 1 : 0;
      continue;
    }
    unsupported = true;
    risks.push({ code: 'parser.posix-unsupported-operator', reason: `尚未覆盖 POSIX 操作符 ${token.op}` });
  }

  /** 检测命令替换 $()——将 $ 和后续 (...) 标记为嵌套文本。 */
  const detectCommandSubstitution = (): void => {
    for (let i = 0; i < words.length; i++) {
      if (words[i] === '$' && i + 1 < words.length && words[i + 1] === '(') {
        if (!enableNested) {
          unsupported = true;
          risks.push({ code: 'structure.command-substitution', reason: '检测到 $() 命令替换嵌套' });
        }
        break;
      }
    }
  };
  detectCommandSubstitution();
  flushNode();

  if (nodes.length > MAX_COMMAND_NODES) {
    return {
      parseStatus: 'unsupported',
      nodes,
      riskSignals: [...risks, {
        code: 'structure.too-many-subcommands',
        reason: `子命令数量超过 ${MAX_COMMAND_NODES} 个安全上限`,
      }],
    };
  }
  if (nodes.length === 0 && command.trim() !== '') {
    return {
      parseStatus: 'invalid',
      nodes: [],
      riskSignals: [...risks, { code: 'parser.posix-empty', reason: '未解析到可执行命令节点' }],
    };
  }
  return {
    parseStatus: unsupported ? 'unsupported' : 'parsed',
    nodes,
    riskSignals: risks,
  };
}
