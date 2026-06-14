/**
 * 终端界面（CLI）核心交互层。
 * 负责绑定标准输入输出（stdin/stdout），承接用户的终端文本流，并向大脑层订阅与渲染 AI 思考事件。
 */
import { createInterface } from 'readline';
import * as p from '@clack/prompts';
import { SessionManager } from '../brain/index.js';
import { dispatchCommand } from './command.js';
import { loadSkills } from '../brain/contextLoader.js';

import { theme } from '../utils/theme.js';

async function showInteractiveMenu(): Promise<string | null> {
  console.log();
  const mainAction = await p.select({
    message: '选择要执行的操作:',
    options: [
      { value: 'skill', label: '调用特殊技能 (Skill)' },
      { value: 'model', label: '切换大模型配置 (Model)' },
      { value: 'rollback', label: '撤销上轮对话 (Rollback)' },
      { value: 'history', label: '查看历史记录 (History)' },
      { value: 'resume', label: '恢复历史会话 (Resume)' },
      { value: 'tool', label: '查看扩展工具清单 (Tool)' },
      { value: 'mcp', label: '管理 MCP 服务 (MCP)' },
      { value: 'reload-rules', label: '重载全局和项目规则 (Reload Rules)' },
      { value: 'help', label: '查看帮助 (Help)' },
      { value: 'cancel', label: '取消' },
    ]
  });

  if (p.isCancel(mainAction) || mainAction === 'cancel') {
    p.cancel('操作已取消。');
    return null;
  }

  if (mainAction === 'skill') {
    const allSkills = loadSkills();
    if (allSkills.length === 0) {
      p.outro(theme.info('未发现任何可用技能。'));
      return null;
    }

    const skillSelect = await p.select({
      message: '请选择要挂载的临时技能:',
      options: allSkills.map(s => ({
        value: s.name,
        label: `${s.name} - ${s.description}`
      }))
    });

    if (p.isCancel(skillSelect)) {
      p.cancel('操作已取消。');
      return null;
    }

    const taskText = await p.text({
      message: '请输入希望技能执行的具体任务:',
      placeholder: '例如：帮我查一下... / 帮我写一下...',
      validate(value) {
        if (!value || !value.trim()) return '任务要求不能为空';
      }
    });

    if (p.isCancel(taskText)) {
      p.cancel('操作已取消。');
      return null;
    }

    return `/skill ${skillSelect as string} ${taskText as string}`;
  }

  if (['model', 'history', 'tool', 'help', 'reload-rules'].includes(mainAction as string)) {
    return `/${mainAction}`;
  }

  if (mainAction === 'resume') {
    const id = await p.text({ message: '请输入要恢复的会话 ID:' });
    if (p.isCancel(id) || !id) return null;
    return `/resume ${id}`;
  }

  if (mainAction === 'mcp') {
    return `/mcp list`; 
  }

  if (mainAction === 'rollback') {
    return `/rollback 1`; 
  }

  return null;
}

/**
 * 清屏并重新渲染当前生效的会话上下文。
 * 用于回滚操作后，彻底抹除终端上被丢弃的多余对话残留。
 */
export function redrawHistory(session: SessionManager) {
  console.clear();
  console.log(theme.dim('--- 时间旅行完成，当前剩余的有效记忆 ---'));
  
  const history = session.getHistory();
  for (const msg of history) {
    if (msg.role === 'system') continue;
    
    if (msg.role === 'user') {
      let contentStr = '';
      if (typeof msg.content === 'string') {
        contentStr = msg.content;
      } else if (Array.isArray(msg.content)) {
        contentStr = msg.content.map(p => ('text' in p ? p.text : '')).join('\n');
      }
      console.log(`\n${theme.info(`用户 [${session.getModelName()}] > `)}${renderContentWithWidgets(contentStr)}`);
    } else if (msg.role === 'assistant') {
      // 强转是为了兼容提取本地存储时的隐藏属性（例如 DeepSeek 特有的 reasoning_content）
      const customMsg = msg as unknown as { reasoning_content?: string };
      if (customMsg.reasoning_content) {
        console.log(`\n${theme.dim('[思考过程]')}\n${theme.dim(customMsg.reasoning_content)}`);
      }
      if (msg.content) {
        console.log(`\n${msg.content}`);
      }
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          console.log(`\n${theme.info(`[⚡ 工具调用记录: "${tc.function.name}"]`)}`);
        }
      }
    } else if (msg.role === 'tool') {
      console.log(theme.dim(`[反馈] 工具执行完毕。`));
    }
  }
  console.log(`\n${theme.divider('以上为当前状态 >')} 随时准备继续\n`);
}

/**
 * 初始化并启动基于 readline 的 REPL（交互式解释器）主循环。
 * 将控制台的按行输入转化为对 SessionManager 的多轮对话驱动。
 * 
 * @param session 已在系统启动层装配完毕的会话管理器实例
 */
export function startCli(session: SessionManager) {
  // 定义 readline 接口实例变量，留作闭包内复用
  let rl: ReturnType<typeof createInterface>;
  let isGenerating = false;
  let lastEscapeTime = 0;
  
  // 外部维系终端输入历史记录，打破 rl 实例销毁导致的“记忆断层”
  const commandHistory: string[] = [];

  // 挂载全局按键监听以实现双击 ESC 快捷键
  process.stdin.on('keypress', (str, key) => {
    if (key && key.name === 'escape') {
      const now = Date.now();
      if (now - lastEscapeTime < 500) {
        // 触发双击 ESC
        if (isGenerating) {
          session.abort();
        } else {
          // 清除当前输入行的残留
          process.stdout.write('\r' + ' '.repeat(50) + '\r');
          if (rl) {
            rl.question(theme.highlight('\n[系统] 确定要撤销上一轮对话吗？(y/N) > '), (answer) => {
              if (answer.toLowerCase() === 'y') {
                session.rollback(1);
                // 执行清屏与历史重绘，让被回退的内容真正从终端消失
                redrawHistory(session);
              } else {
                console.log(theme.dim('[系统] 已取消回滚。'));
              }
              rl.prompt();
            });
          }
        }
        lastEscapeTime = 0;
      } else {
        lastEscapeTime = now;
      }
    }
  });

  /**
   * 内部工厂方法：用于初始化或重置终端监听器。
   * 当切出至其他交互模式（如 Slash Command）结束后，需要调用此方法重新接管 stdin。
   */
  const initRl = () => {
    const completer = (line: string) => {
      if (line.startsWith('/')) {
        const commands = ['/model', '/rollback', '/help', '/history', '/resume', '/mcp', '/tool', '/skill'];
        const hits = commands.filter((c) => c.startsWith(line));
        return [hits.length ? hits : [], line];
      }
      return [[], line];
    };

    rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      completer: completer,
      history: commandHistory
    });

    /**
     * 根据当前挂载的大模型名称，动态刷新终端输入提示符
     */
    const updatePrompt = () => {
      rl.setPrompt(theme.info(`用户 [${session.getModelName()}] > `));
    };

    // 首次启动时主动渲染输入提示符
    updatePrompt();
    rl.prompt();

    const runStreamLoop = async (transientSkill?: string) => {
      isGenerating = true;
      try {
        let hasPrintedReasoning = false;
        let hasPrintedContent = false;
        for await (const event of session.chat(transientSkill)) {
          switch (event.type) {
            case 'thinking':
              if (!hasPrintedReasoning) {
                process.stdout.write(`\n${theme.dim('[思考过程]')}\n`);
                hasPrintedReasoning = true;
              }
              process.stdout.write(theme.dim(event.content));
              break;
            case 'content':
              if (!hasPrintedContent) {
                if (hasPrintedReasoning) process.stdout.write('\n\n');
                hasPrintedContent = true;
              }
              process.stdout.write(event.content);
              break;
            case 'tool_call_start':
              process.stdout.write(`\n\n${theme.info(`[⚡ 正在调用工具 "${event.functionName}"]`)}\n`);
              console.log(theme.highlight(`[调度参数] ${JSON.stringify(event.functionArgs)}`));
              break;
            case 'tool_call_result':
              console.log(theme.dim(`[反馈] 工具 "${event.functionName}" 执行完毕，返回了 ${event.result.length} 字节的数据。`));
              break;
            case 'error':
              console.log(theme.error(`[异常] ${event.message}`));
              break;
          }
        }
        console.log(`\n\n${theme.divider('系统响应 >')} 完毕。\n`);

        // 获取并展示本轮交互后的 Token 状态回显面板
        const lastEstimated = session.getLastEstimatedUsage();
        const lastUsage = session.getLastApiUsage();
        if (lastEstimated) {
          const systemTokens = lastEstimated.system ?? 0;
          const rulesTokens = lastEstimated.rules ?? 0;
          const skillTokens = lastEstimated.transient ?? 0;
          const historyTokens = lastEstimated.history ?? 0;
          const totalEstimated = lastEstimated.total ?? 0;

          const pctSystem = totalEstimated > 0 ? ((systemTokens / totalEstimated) * 100).toFixed(1) : '0.0';
          const pctRules = totalEstimated > 0 ? ((rulesTokens / totalEstimated) * 100).toFixed(1) : '0.0';
          const pctSkill = totalEstimated > 0 ? ((skillTokens / totalEstimated) * 100).toFixed(1) : '0.0';
          const pctHistory = totalEstimated > 0 ? ((historyTokens / totalEstimated) * 100).toFixed(1) : '0.0';

          const contextWindow = 64000;
          const totalActual = lastUsage ? (lastUsage.input_tokens + lastUsage.output_tokens) : totalEstimated;
          const windowRatio = ((totalActual / contextWindow) * 100).toFixed(1);

          let actualInput = '暂无数据';
          let actualOutput = '暂无数据';
          let cachedTokens = 0;
          let hitRate = '0.0';
          let costStr = '暂无数据';

          if (lastUsage) {
            actualInput = String(lastUsage.input_tokens);
            actualOutput = String(lastUsage.output_tokens);
            cachedTokens = lastUsage.prompt_tokens_details?.cached_tokens ?? 0;
            hitRate = lastUsage.input_tokens > 0 ? ((cachedTokens / lastUsage.input_tokens) * 100).toFixed(1) : '0.0';

            const inputCost = (lastUsage.input_tokens - cachedTokens) * 0.00014 / 1000 + cachedTokens * 0.000014 / 1000;
            const outputCost = lastUsage.output_tokens * 0.00028 / 1000;
            const totalCostUsd = inputCost + outputCost;
            const totalCostCny = totalCostUsd * 7.25;
            costStr = `$${totalCostUsd.toFixed(6)} (约 ￥${totalCostCny.toFixed(5)})`;
          }

          const systemHash = session.getSystemPromptHash();
          const hashShort = systemHash ? systemHash.slice(0, 8) : '暂无';

          console.log(theme.divider('======================= 📊 TOKEN 监控面板 ======================='));
          console.log(`${theme.highlight('💡 预测 Token 预算：')}${totalEstimated}`);
          console.log(`   ├── 基础人设 (System):  ${systemTokens} (${pctSystem}%)`);
          console.log(`   ├── 规则集   (Rules):   ${rulesTokens} (${pctRules}%)`);
          console.log(`   ├── 临时技能 (Skill):   ${skillTokens} (${pctSkill}%)`);
          console.log(`   └── 历史对话 (History): ${historyTokens} (${pctHistory}%)`);
          console.log(theme.dim('--------------------------------------------------------------'));
          console.log(`${theme.highlight('⚡ API 实际结算 (Usage)：')}`);
          console.log(`   ├── 输入 Token (Input):  ${actualInput}`);
          console.log(`   ├── 输出 Token (Output): ${actualOutput}`);
          console.log(`   ├── 缓存命中 (Cached):   ${cachedTokens} (${hitRate}%)`);
          console.log(`   ├── 窗口占用 (Window):   ${totalActual} / ${contextWindow} (${windowRatio}%)`);
          console.log(`   └── 本轮估算花费 (Cost):  ${theme.success(costStr)}`);
          console.log(theme.dim('--------------------------------------------------------------'));
          console.log(`${theme.highlight('🔒 缓存一致性哈希 (Cache Hash)：')}${hashShort}`);
          console.log(theme.divider('================================================================'));
          console.log();
        }
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        process.stdout.write(' '.repeat(60) + '\r');
        console.log(`\n${theme.error(`[系统故障] ${errorMsg}`)}\n`);
      } finally {
        isGenerating = false;
      }
    };

    // 绑定回车键触发的整行文本提交事件
    rl.on('line', async (line) => {
      // 抹除首尾空格，防止无效空白干扰
      let input = line.trim();

      // 1. 预处理：解析退出指令，提供安全终止流程
      if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
        console.log(`\n${theme.success('[系统] 进程正在终止，结束会话。')}`);
        rl.close();
        process.exit(0);
      }

      // 2. 预处理：拦截纯换行或空输入
      if (!input) {
        rl.prompt();
        return;
      }

      // 3. 全局交互式菜单入口
      if (input === '/') {
        rl.close();
        try {
          const menuResult = await showInteractiveMenu();
          if (!menuResult) {
            initRl();
            return;
          }
          input = menuResult; // 覆盖原始输入并掉入后续逻辑
        } catch {
          initRl();
          return;
        }
      }

      // 4. 拦截斜杠命令（Slash Command），将其分发至独立的界面层路由器
      if (input.startsWith('/')) {
        rl.close();
        try {
          const cmdResult = await dispatchCommand(input, { session, rl });
          if (cmdResult && cmdResult.transientSkillContent && cmdResult.userMessage) {
            session.addUserMessage(cmdResult.userMessage);
            await runStreamLoop(cmdResult.transientSkillContent);
          }
        } finally {
          // 命令执行完毕后，无论成功与否均重新初始化 REPL 界面
          initRl();
        }
        return;
      }

      // 5. 正式推进会话状态：将有效文本推送至大脑层维护的历史记忆中
      session.addUserMessage(input);
      await runStreamLoop();

      // 释放锁并恢复终端控制权，接纳下一轮全新指令
      rl.prompt();
    });

    // 绑定系统级中断信号处理（如 Ctrl+C）
    rl.on('SIGINT', () => {
      console.log(`\n${theme.success('[系统] 收到中断信号，程序退出。')}`);
      rl.close();
      process.exit(0);
    });
  };

  // 挂载初次监听
  initRl();
}

/**
 * 将消息内容中内含的 XML 标签和定界符，解析并折叠转换为具有终端视觉效果的精美标签卡片微件。
 */
export function renderContentWithWidgets(content: string): string {
  if (!content) return content;

  let cleanText = content;
  const widgets: string[] = [];

  // 1. 匹配并解析 project_rules
  const rulesRegex = /<project_rules>([\s\S]*?)<\/project_rules>/g;
  let rulesMatch;
  while ((rulesMatch = rulesRegex.exec(content)) !== null) {
    const len = rulesMatch[1].length;
    widgets.push(`  ${theme.dim('↙')} ${theme.highlight('rules: project_rules')} ${theme.dim(`(${len} 字符 - 已自动折叠锁定缓存)`)}`);
  }
  cleanText = cleanText.replace(rulesRegex, '');

  // 2. 匹配并解析 transient_skill
  const skillRegex = /<transient_skill>([\s\S]*?)<\/transient_skill>/g;
  let skillMatch;
  while ((skillMatch = skillRegex.exec(content)) !== null) {
    const len = skillMatch[1].length;
    widgets.push(`  ${theme.dim('↙')} ${theme.highlight('skill: transient_skill')} ${theme.dim(`(${len} 字符 - 已自动折叠锁定缓存)`)}`);
  }
  cleanText = cleanText.replace(skillRegex, '');

  // 3. 过滤系统声明前置与后置定界语
  cleanText = cleanText
    .replace(/\[SYSTEM NOTE:[\s\S]*?\]\n?/g, '')
    .replace(/\n?\[END OF SYSTEM NOTE\]/g, '')
    .trim();

  if (widgets.length > 0) {
    return `${cleanText}\n\n${widgets.join('\n')}`;
  }

  return cleanText;
}
