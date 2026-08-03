import { join, dirname, resolve, relative } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { SessionContext } from '../../domain/context.js';
import type {
  ToolMetadata,
  ToolRegistryPort,
} from '../../../ports/driven/tools/ToolRegistryPort.js';

/** 统一工具输出默认最大行数。 */
const DEFAULT_TOOL_OUTPUT_MAX_LINES = 2000;

/** 统一工具输出默认最大字节数。 */
const DEFAULT_TOOL_OUTPUT_MAX_BYTES = 50 * 1024;

/**
 * 判断原始工具结果是否会被统一输出层原样交给模型。
 * 需要把工具结果转化为后续写入凭证的调用方必须先使用该判断，
 * 禁止为模型只看到折叠预览的内容签发完整读取凭证。
 *
 * @param tool - 工具元数据；缺失时使用统一默认配额
 * @param toolResult - 即将交给 ToolDispatcher 的序列化原始结果
 * @returns 行数和 UTF-8 字节数都未超过配额时返回 true
 */
export function isToolOutputWithinQuota(
  tool: Pick<ToolMetadata, 'maxLines' | 'maxBytes'> | undefined,
  toolResult: string,
): boolean {
  const maxLines = tool?.maxLines ?? DEFAULT_TOOL_OUTPUT_MAX_LINES;
  const maxBytes = tool?.maxBytes ?? DEFAULT_TOOL_OUTPUT_MAX_BYTES;
  return toolResult.split('\n').length <= maxLines
    && Buffer.byteLength(toolResult, 'utf-8') <= maxBytes;
}

/**
 * 按工具编排器的真实模型回执格式序列化执行结果。
 * 所有提前估算输出配额的调用方必须复用该函数，避免只计算内层文本而漏掉
 * CallToolResult 包络和二次 JSON 转义开销。
 *
 * @param outcomeValue - ToolRegistry 返回的 outcome.value
 * @returns 与工具编排器写入模型消息完全一致的 JSON 字符串
 */
export function serializeToolOutcomeForModel(outcomeValue: unknown): string {
  const serialized = JSON.stringify(outcomeValue);
  if (typeof serialized !== 'string') {
    throw new TypeError('工具执行结果无法序列化为模型可见文本');
  }
  return serialized;
}

/**
 * 按本地原生工具经过 ToolGateway 后的真实包络序列化文本结果。
 *
 * @param text - NativeTool.execute 返回的文本
 * @returns 包含 CallToolResult 包络的最终模型可见字符串
 */
export function serializeNativeToolTextResultForModel(text: string): string {
  return serializeToolOutcomeForModel({
    content: [{ type: 'text', text }],
  });
}

/**
 * 判断 ToolRegistry 执行结果经过最终序列化后是否会被统一输出层原样交给模型。
 *
 * @param tool - 工具元数据；缺失时使用统一默认配额
 * @param outcomeValue - ToolRegistry 返回的 outcome.value
 * @returns 最终模型可见字符串在配额内时返回 true；无法序列化时返回 false
 */
export function isToolOutcomeWithinQuota(
  tool: Pick<ToolMetadata, 'maxLines' | 'maxBytes'> | undefined,
  outcomeValue: unknown,
): boolean {
  try {
    return isToolOutputWithinQuota(
      tool,
      serializeToolOutcomeForModel(outcomeValue),
    );
  } catch {
    return false;
  }
}

/**
 * 负责工具返回值的拦截与加工：
 * 1. 过滤拦截巨型返回负载（大文本防爆处理）。
 * 2. 对需要上下文陪伴响应的代码文件进行 JIT（Just-In-Time）规则注入。
 */
export class ToolDispatcher {
  /**
   * 实例初始化。
   *
   * @param context - 会话上下文管理实例
   * @param toolRegistry - 可选的工具注册端口实例，用于动态获取工具的配额
   * @param toolOutputsDir - 工具输出产物目录绝对路径（来自 ApplicationPaths.toolOutputsDir）
   * @param workspacePath - 可选的工作区根路径，用于 JIT 规则寻路
   */
  constructor(
    private context: SessionContext,
    private toolRegistry: ToolRegistryPort | undefined,
    private toolOutputsDir: string,
    private workspacePath?: string
  ) {}

  /**
   * 拦截并处理超大工具输出。
   * 若输出超出去中心化行数与字节配额，执行同步落盘到当前项目的应用数据产物目录，
   * 触发双向行级及字节对折算法，产生大文本折叠预览并返回包含原始路径等元数据的复合结果。
   * 
   * @param functionName - 被调用的工具名称
   * @param toolResult - 原始工具输出结果
   * @returns 包含折叠预览内容、完整文本物理路径及截断标志的复合结果对象
   */
  public handleLargeToolOutput(functionName: string, toolResult: string): {
    content: string;
    originalPath?: string;
    isTruncated: boolean;
  } {
    const tool = this.toolRegistry?.getTool(functionName);
    const maxLines = tool?.maxLines ?? DEFAULT_TOOL_OUTPUT_MAX_LINES;
    const maxBytes = tool?.maxBytes ?? DEFAULT_TOOL_OUTPUT_MAX_BYTES;

    const lines = toolResult.split('\n');

    // 若行数和字节数都在限额之内，则不执行任何裁剪
    if (isToolOutputWithinQuota(tool, toolResult)) {
      return { content: toolResult, isTruncated: false };
    }

    // 确定工具输出落盘目录，并确保目录存在
    const outputDir = this.toolOutputsDir;
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    // 产生唯一的随机文件名
    const randomId = Math.random().toString(36).substring(2, 10);
    const timestamp = Date.now();
    const tempFileName = `tool_${timestamp}_${randomId}.log`;
    const fullPath = join(outputDir, tempFileName);

    // 将完整的原始大文本写入本地物理文件，保障原始日志 100% 物理保全
    writeFileSync(fullPath, toolResult, 'utf-8');
    const relativePath = fullPath;

    // 双向行对半对折算法
    const headLines = Math.ceil(maxLines / 2);
    const tailLines = Math.floor(maxLines / 2);
    const headPart = lines.slice(0, headLines).join('\n');
    const tailPart = tailLines > 0 ? lines.slice(lines.length - tailLines).join('\n') : '';

    let foldedText = tailPart ? `${headPart}\n\n[... output truncated ...]\n\n${tailPart}` : headPart;

    // 若行级折叠后依然超出字节限制，则降级为字节级截取
    if (Buffer.byteLength(foldedText, 'utf-8') > maxBytes) {
      const byteHalf = Math.floor(maxBytes / 2);
      const buf = Buffer.from(toolResult, 'utf-8');
      const headBuf = buf.subarray(0, byteHalf);
      const tailBuf = buf.subarray(buf.length - byteHalf);
      foldedText = `${headBuf.toString('utf-8')}\n\n[... output truncated ...]\n\n${tailBuf.toString('utf-8')}`;
    }

    // 组装模型及终端渲染用的带引导折叠预览文本
    const content = `[警告：工具 "${functionName}" 的输出内容已超标，完整内容已同步落盘至临时文件：${relativePath}]
[提示：若要调阅完整内容，请调用 "readFile" 工具，传入 "targetPath": "${relativePath}"。]
[以下为对折截断后的预览]：
${foldedText}`;

    return {
      content,
      originalPath: relativePath,
      isTruncated: true
    };
  }

  /**
   * JIT 伴生规范注入处理器。
   * 沿着目标文件的目录树递归向上寻路，查找 README.md 或 .rules 文件。
   * 遵循以下规则防洪防爆：
   * 1. 排除根目录寻路（寻路截止于根目录的直接子级，current !== root）。
   * 2. 全会话历史去重（解析 messages 排除曾经注入过的规则文件路径）。
   * 3. 单轮交互内去重（Turn Deduplication，Set 拦截）。
   * 
   * @param targetPath - 被读取的目标文件路径
   * @param injectedJitPaths - 当前交互轮次中已注入的规范文件相对路径集合
   * @returns 组装好的 `<system-reminder>` 提示词文本，若无需注入则返回空字符串
   */
  public resolveJitContext(targetPath: string, injectedJitPaths: Set<string>): string {
    const root = this.workspacePath || process.cwd();
    const targetAbs = resolve(root, targetPath);
    let current = dirname(targetAbs);

    // 收集历史消息中已经成功加载过的 JIT 规则（全局去重）
    const alreadyInjectedGlobally = new Set<string>();
    const history = this.context.getHistory();
    for (const msg of history) {
      if (typeof msg.content === 'string') {
        const regex = /\[JIT 规则已加载: ([^\]]+)\]/g;
        let match;
        while ((match = regex.exec(msg.content)) !== null) {
          alreadyInjectedGlobally.add(match[1]);
        }
      }
    }

    const ruleFiles = ['README.md', '.rules'];
    let JITText = '';

    // 递归向上遍历，直至根目录前级（排除 root 根目录本身）
    while (current.startsWith(root) && current !== root) {
      let foundRuleFile: string | null = null;
      for (const ruleFile of ruleFiles) {
        const potentialPath = resolve(current, ruleFile);
        if (existsSync(potentialPath)) {
          foundRuleFile = potentialPath;
          break;
        }
      }

      if (foundRuleFile) {
        const relRulePath = relative(root, foundRuleFile).replace(/\\/g, '/');

        // 执行双重去重（全局历史与当前 Turn）
        if (!alreadyInjectedGlobally.has(relRulePath) && !injectedJitPaths.has(relRulePath)) {
          try {
            const ruleContent = readFileSync(foundRuleFile, 'utf-8');
            if (ruleContent.trim()) {
              JITText += `\n\n---\n[JIT 规则已加载: ${relRulePath}]\n<system-reminder>\n${ruleContent}\n</system-reminder>`;
              injectedJitPaths.add(relRulePath);
            }
          } catch {
            // 忽略异常，安全过滤
          }
        }
        // 第一条 project-level 优先级规则匹配成功后，跳出且不再向上追溯。
        break;
      }

      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }

    return JITText;
  }
}
