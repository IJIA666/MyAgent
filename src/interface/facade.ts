import readline from 'readline';
import { SessionManager } from '../brain/index.js';
import { InputListener } from './io/input-listener.js';
import { redrawHistory, renderTokenPanel } from './views/widget-renderer.js';
import { dispatchCommand, showInteractiveMenu } from './command.js';
import { theme } from './views/theme.js';
import { waitUserIntervention } from './cli.js';

/**
 * 终端界面控制门面（Facade）。
 * 组合输入捕获、命令解析分发与视图无状态渲染，作为用户界面层的主协调调度中心。
 */
export class CliFacade {
  /** 当前大脑层的会话管理器实例 */
  private session: SessionManager;
  /** 控制台键盘与行输入监听器 */
  private listener: InputListener;
  /** 当前大模型是否正在推理生成中 */
  private isGenerating = false;

  /**
   * 构造函数，建立与 SessionManager 的绑定，并实例化键盘输入监听器。
   *
   * @param session - 大脑层会话管理器实例
   */
  constructor(session: SessionManager) {
    this.session = session;

    // 实例化 InputListener，以单向事件流驱动 Facade 做出业务控制决策
    this.listener = new InputListener({
      getIsGenerating: () => this.isGenerating,
      getModelName: () => this.session.getModelName(),
      onAbort: () => {
        this.session.abort();
      },
      onRollback: () => {
        this.session.rollback(1);
        // 调用解耦后的 redrawHistory 进行历史重绘，只传入数据而非 session 实例
        redrawHistory(this.session.getHistory(), this.session.getModelName());
      },
      onLineSubmit: async (line) => {
        await this.handleLineSubmit(line);
      }
    });

    // 注册底座的审批卡关回调，实现实时非阻塞终端交互，防止 Generator 原地挂起造成死锁
    this.session.approvalService.registerApprovalHandler(async (id, toolCall, allowedPrefix, message) => {
      // 物理注销全局监听器，彻底隔离 Stdin，杜绝回显污染与事件穿透
      this.listener.close();

      const decision = await new Promise<'once' | 'always' | 'deny'>((resolve) => {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });
        // 智能展示提示信息，增强文件越界卡关的可读性
        if (message) {
          console.log(`\n⚠️  ${theme.warning('[安全提示] ')}${message}`);
        }

        // 如果是终端命令，则额外高亮打印要执行的完整指令
        const command = toolCall.arguments?.command as string | undefined;
        if (command) {
          if (!message) {
            console.log(`\n⚠️  ${theme.warning('[安全提示] Agent 企图执行以下终端命令：')}`);
          }
          console.log(`   👉  \x1b[33m${command}\x1b[0m`);
        }

        if (allowedPrefix) {
          console.log('选择操作:');
          console.log('  [1] 单次放行 (Allow Once)');
          console.log(`  [2] 始终放行该前缀命令 (Always Allow "${allowedPrefix}:*")`);
          console.log('  [3] 拒绝执行 (Deny)');

          const ask = () => {
            rl.question('请选择 [1/2/3]: ', (answer) => {
              const ans = answer.trim();
              if (ans === '1') {
                rl.close();
                resolve('once');
              } else if (ans === '2') {
                rl.close();
                resolve('always');
              } else if (ans === '3') {
                rl.close();
                resolve('deny');
              } else {
                console.log('无效选择，请重新输入。');
                ask();
              }
            });
          };
          ask();
        } else {
          console.log('选择操作:');
          console.log('  [1] 单次放行 (Allow Once)');
          console.log('  [2] 拒绝执行 (Deny)');

          const ask = () => {
            rl.question('请选择 [1/2]: ', (answer) => {
              const ans = answer.trim();
              if (ans === '1') {
                rl.close();
                resolve('once');
              } else if (ans === '2') {
                rl.close();
                resolve('deny');
              } else {
                console.log('无效选择，请重新输入。');
                ask();
              }
            });
          };
          ask();
        }
      });

      // 直接将外部用户的决策通过 resolve 回传至 ApprovalService 唤醒内核
      this.session.approvalService.resolve(id, { action: decision });

      // 物理重建全局监听器，由于当前还在生成推理中，重建后的实例会自动保持 pause 状态，不会展示 Prompt 提示符
      this.listener.start();
    });

    // 注册浏览器人机风控协作的黄色高亮阻塞干预回调
    this.session.registerInterventionHandler(async (message) => {
      // 1. 挂起全局 InputListener 监听器以释放 stdin
      this.listener.close();
      try {
        // 2. 调用 CLI 专属的黄色阻塞高亮 UI 和 stdin 阻塞函数
        await waitUserIntervention(message);
      } finally {
        // 3. 阻塞释放后重建全局监听器，并恢复其正确的 start 状态
        this.listener.start();
      }
    });
  }

  /**
   * 启动终端交互 REPL 主循环。
   */
  public start(): void {
    this.listener.start();
  }

  /**
   * 清屏并重新绘制当前有效的会话历史，对外提供兼容接口。
   */
  public redraw(): void {
    redrawHistory(this.session.getHistory(), this.session.getModelName());
  }

  /**
   * 处理整行控制台输入的总控决策。
   *
   * @param line - 原始输入文本
   */
  private async handleLineSubmit(line: string): Promise<void> {
    let input = line.trim();

    // 1. 退出指令检查
    if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
      console.log(`\n${theme.success('[系统] 进程正在终止，结束会话。')}`);
      this.listener.close();
      await this.session.close();
      process.exit(0);
    }

    // 2. 空行过滤
    if (!input) {
      this.listener.prompt();
      return;
    }

    // 3. 交互式菜单激活 (输入单个 / 触发)
    if (input === '/') {
      this.listener.pause(); // 挂起常规输入监听，防 stdin 抢占
      try {
        const menuResult = await showInteractiveMenu();
        if (!menuResult) {
          return;
        }
        input = menuResult; // 覆盖原始输入，落入后面的斜杠命令处理
      } catch {
        return;
      } finally {
        this.listener.resume(); // 菜单退出，重新恢复监听
      }
    }

    // 4. 斜杠指令路由分发 (以 / 开头)
    if (input.startsWith('/')) {
      this.listener.pause(); // 挂起常规输入监听
      try {
        const cmdResult = await dispatchCommand(input, {
          session: this.session,
          rl: this.listener.getInterface()!
        });

        // 如果命令返回了需要与 LLM 交互的追加会话与沙盒技能，在此推进大循环
        if (cmdResult && cmdResult.transientSkillContent && cmdResult.userMessage) {
          this.session.addUserMessage(cmdResult.userMessage);
          await this.runStreamLoop(cmdResult.transientSkillContent);
        }
      } finally {
        this.listener.resume(); // 命令处理完，恢复监听
      }
      return;
    }

    // 5. 常规对话处理
    this.listener.pause();
    try {
      this.session.addUserMessage(input);
      await this.runStreamLoop();
    } finally {
      this.listener.resume();
    }
  }

  /**
   * 订阅并渲染底层的流式推理会话事件。
   *
   * @param transientSkill - 可选的沙盒技能规范内容
   */
  private async runStreamLoop(transientSkill?: string): Promise<void> {
    this.isGenerating = true;
    try {
      let hasPrintedReasoning = false;
      let hasPrintedContent = false;

      // 订阅并逐步消费大脑层抛出的推理事件
      for await (const event of this.session.chat(transientSkill)) {
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
          case 'suspend': {
            // 由于底座在 wait 前已通过 registerApprovalHandler 同步拉起交互并完成决策，
            // 局部 eventQueue 中的 suspend 事件滞后到达时无需重复触发，直接跳过即可。
            break;
          }
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

      // 渲染 Token 信息和哈希指纹监控面板
      renderTokenPanel(
        this.session.getLastEstimatedUsage(),
        this.session.getLastApiUsage(),
        this.session.getSystemPromptHash()
      );
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      process.stdout.write(' '.repeat(60) + '\r');
      console.log(`\n${theme.error(`[系统故障] ${errorMsg}`)}\n`);
    } finally {
      this.isGenerating = false;
    }
  }
}
