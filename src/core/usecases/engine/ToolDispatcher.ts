import { join, dirname, resolve, relative } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { SessionContext } from '../../domain/context.js';

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
   * @param workspacePath - 可选的工作区根路径，用于重定向大文本拦截缓存与 JIT 规则寻路
   */
  constructor(
    private context: SessionContext,
    private workspacePath?: string
  ) {}

  /**
   * 拦截并处理超大工具输出。
   * 如果输出长度超过 8000 字符，执行落盘到工作区内的 .myagent/temp/ 目录，
   * 并将内容替换为带有首尾预览及分页读取引导的占位符。
   * 
   * @param functionName - 被调用的工具名称
   * @param toolResult - 原始工具输出结果
   * @returns 过滤或拦截后的工具输出结果
   */
  public handleLargeToolOutput(functionName: string, toolResult: string): string {
    const limit = this.context.appConfig?.runtimeLimits.largeToolOutputLimit ?? 8000;
    if (toolResult.length <= limit) {
      return toolResult;
    }

    // 确定临时落盘目录，并确保目录存在
    const tempDir = join(this.workspacePath || process.cwd(), '.myagent/temp');
    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true });
    }

    // 产生唯一的随机文件名
    const randomId = Math.random().toString(36).substring(2, 10);
    const timestamp = Date.now();
    const tempFileName = `output_${timestamp}_${randomId}.txt`;
    const fullPath = join(tempDir, tempFileName);

    // 将大文本输出写入本地物理文件
    writeFileSync(fullPath, toolResult, 'utf-8');

    // 截取前部和尾部预览
    const previewStart = toolResult.substring(0, 1000);
    const previewEnd = toolResult.substring(toolResult.length - 1000);
    const relativePath = `.myagent/temp/${tempFileName}`;

    // 返回经过过滤与占位指引后的文本提示
    return `[警告：工具 "${functionName}" 的输出内容过长（共 ${toolResult.length} 字符），已自动拦截并落盘至临时文件。]
[临时文件路径：${relativePath}]
[前 1000 字符预览]：
${previewStart}
...
[后 1000 字符预览]：
${previewEnd}
[提示：若要调阅上述完整或指定行范围的内容，请调用 "readFile" 工具，传入 "targetPath": "${relativePath}" 并指定 lineStart 和 lineEnd。]`;
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
        // 第一 project-level 优先级匹配成功后，跳出不再向上追溯（对齐 Opencode 机制）
        break;
      }

      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }

    return JITText;
  }
}
