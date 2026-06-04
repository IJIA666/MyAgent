/**
 * 终端界面（CLI）核心交互层。
 * 负责绑定标准输入输出（stdin/stdout），承接用户的终端文本流，并向大脑层订阅与渲染 AI 思考事件。
 */
import { createInterface } from 'readline';
import { SessionManager } from '../brain/index.js';
import { dispatchCommand } from './command.js';

import { theme } from './theme.js';

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

    // 绑定回车键触发的整行文本提交事件
    rl.on('line', async (line) => {
      // 抹除首尾空格，防止无效空白干扰
      const input = line.trim();

      // 1. 预处理：解析退出指令，提供安全终止流程
      if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
        console.log(`\n${theme.success('[系统] 进程正在终止，结束会话。')}`);
        rl.close();
        process.exit(0);
      }

      // 2. 预处理：拦截纯换行或空输入，规避无意义交互触发
      if (!input) {
        rl.prompt();
        return;
      }

      // 3. 拦截斜杠命令（Slash Command），将其分发至独立的界面层路由器
      if (input.startsWith('/')) {
        // 彻底关闭并解绑原有的 readline 监听，将 stdin 流转交出去
        rl.close();
        try {
          await dispatchCommand(input, { session, rl });
        } finally {
          // 命令执行完毕后，无论成功与否均重新初始化 REPL 界面
          initRl();
        }
        return;
      }

      // 4. 正式推进会话状态：将有效文本推送至大脑层维护的历史记忆中
      session.addUserMessage(input);

      isGenerating = true;
      try {
        // 标记位：用于控制打印流时的换行排版逻辑
        let hasPrintedReasoning = false;
        let hasPrintedContent = false;

        // 5. 消费事件流：发起大模型推理请求，并异步遍历（for await）其产生的事件序列
        for await (const event of session.chat()) {
          switch (event.type) {
            case 'thinking':
              // 首次收到思考节点时，打印独立的分界线标头
              if (!hasPrintedReasoning) {
                process.stdout.write(`\n${theme.dim('[思考过程]')}\n`);
                hasPrintedReasoning = true;
              }
              // 持续追加灰色的推理思绪片段
              process.stdout.write(theme.dim(event.content));
              break;
            case 'content':
              // 首次收到最终文本时，检查是否需要脱离前置的思考区域块
              if (!hasPrintedContent) {
                if (hasPrintedReasoning) {
                  process.stdout.write('\n\n'); 
                }
                hasPrintedContent = true;
              }
              // 实时流式吐出高亮的正常交流内容
              process.stdout.write(event.content);
              break;
            case 'tool_call_start':
              // 侦测到行动层工具被挂载唤醒时，呈现调度信息与参数全貌
              process.stdout.write(`\n\n${theme.info(`[⚡ 正在调用工具 "${event.functionName}"]`)}\n`);
              console.log(theme.highlight(`[调度参数] ${JSON.stringify(event.functionArgs)}`));
              break;
            case 'tool_call_result':
              // 工具运行完毕，告知使用者数据流转的规模字节
              console.log(theme.dim(`[反馈] 工具 "${event.functionName}" 执行完毕，返回了 ${event.result.length} 字节的数据。`));
              break;
            case 'error':
              // 大脑层判定抛出的异常分支，通常是工具拒绝服务或路径越权
              console.log(theme.error(`[异常] ${event.message}`));
              break;
          }
        }

        // 推理流程完结收尾，向标准输出提交最终标识符以区分批次
        console.log(`\n\n${theme.divider('系统响应 >')} 完毕。\n`);

      } catch (error: unknown) {
        // 兜底捕获异常（如网络阻断、协议解析崩溃等）并强制阻断展示
        const errorMsg = error instanceof Error ? error.message : String(error);
        // 使用回车符清理行残留数据，保证错误信息绝对醒目
        process.stdout.write(' '.repeat(60) + '\r');
        console.log(`\n${theme.error(`[系统故障] ${errorMsg}`)}\n`);
      } finally {
        isGenerating = false;
      }

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
