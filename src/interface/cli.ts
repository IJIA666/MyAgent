/**
 * 终端界面（CLI）核心交互层。
 * 负责绑定标准输入输出（stdin/stdout），承接用户的终端文本流，并向大脑层订阅与渲染 AI 思考事件。
 */
import { createInterface } from 'readline';
import * as p from '@clack/prompts';
import { SessionManager } from '../brain/index.js';
import { dispatchCommand } from './command.js';
import { loadSkills } from '../brain/contextLoader.js';

import { theme } from './theme.js';

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

  if (['model', 'history', 'tool', 'help'].includes(mainAction as string)) {
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
      console.log(`\n${theme.info(`用户 [${session.getModelName()}] > `)}${msg.content}`);
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
