import readline from 'readline';
import type { CliSessionUseCase } from '../../../ports/driving/CliSessionUseCase.js';
import type { AgentEvent } from '../../../ports/shared/agent-events.js';
import type { ApprovalChoice } from '../../../ports/shared/approval-types.js';
import type { PendingInteraction } from '../../../ports/shared/pending-interaction.js';
import { InputListener } from './io/input-listener.js';
import {
  redrawHistory,
  renderCompletionBanner,
  renderSectionTitle,
  renderSessionHeader,
  renderTokenPanel,
  renderToolCallResult,
  renderToolCallStart
} from './views/widget-renderer.js';
import { dispatchCommand, showInteractiveMenu } from './command.js';
import { theme } from './views/theme.js';
import { waitUserIntervention } from './cli.js';
import { InteractionHandler } from './interaction-handler.js';
import { BrowserSession } from '../../tools/impl/browser/browser-action.js';
import { logger } from '../../../utils/logger.js';

/**
 * 终端界面控制门面（Facade）。
 * 组合输入捕获、命令解析分发与视图无状态渲染，作为用户界面层的主协调调度中心。
 */
export class CliFacade {
  /** 当前大脑层的会话管理器实例（通过驱动端口契约访问） */
  private session: CliSessionUseCase;
  /** 控制台键盘与行输入监听器 */
  private listener: InputListener;
  /** ask_user_question 的 CLI 交互处理器 */
  private interactionHandler: InteractionHandler;
  /** 渲染侧忙碌状态，用于过滤非本 Tick 触发的多次交互重置 */
  private isRendering = false;
  /** 标识当前轮次是否已打印过思考过程标题 */
  private hasPrintedReasoning = false;
  /** 标识当前轮次是否已打印过内容换行 */
  private hasPrintedContent = false;
  /** 当前处于活跃提问 UI 的 interactionId 集合，用于防重 */
  private activeInteractionIds = new Set<string>();

  /**
   * 构造函数，建立与 ChatUseCase 的绑定，并实例化键盘输入监听器。
   *
   * @param session - 驱动端口会话用例实例
   */
  constructor(session: CliSessionUseCase) {
    this.session = session;

    // 实例化 InputListener，以单向事件流驱动 Facade 做出业务控制决策
    this.listener = new InputListener({
      getIsGenerating: () => this.session.getIsGenerating(),
      getModelName: () => this.session.getModelName(),
      getPermissionMode: () => this.session.getPermissionMode(),
      onAbort: () => {
        this.session.abort();
      },
      onRollback: () => {
        this.session.rollback(1);
        // 调用解耦后的 redrawHistory 进行历史重绘，只传入数据而非 session 实例
        redrawHistory(this.session.getHistory(), this.session.getModelName());
      },
      onLineSubmit: (line) => {
        // 显式处理 Promise rejection，防止异步异常被 EventEmitter 静默吞掉
        void this.handleLineSubmit(line).catch((error: unknown) => {
          const msg = `输入处理失败: ${error instanceof Error ? error.message : String(error)}`;
          logger.error('[CliFacade] onLineSubmit 异常', { error: msg });
          console.log(theme.error(`\n[异常] ${msg}\n`));
          // 异常输出后重新显示 prompt，防止异常日志覆盖 prompt 后用户看不到提示符
          if (!this.session.getIsGenerating()) {
            this.listener.prompt();
          }
        });
      }
    });

    // 创建人机对话交互处理器并通过会话用例回注到 AgentLoop，
    // 供 CLI 侧在收到 interaction_request 事件后渲染提问界面。
    this.interactionHandler = new InteractionHandler({ listener: this.listener });
    this.session.setInteractionPort(this.interactionHandler);

    // 注册底座的审批卡关回调，实现实时非阻塞终端交互，防止 Generator 原地挂起造成死锁
    this.session.registerApprovalHandler(async (id: string, toolCall: { name: string; arguments: Record<string, unknown> }, allowedPrefix?: string, message?: string, choices?: ApprovalChoice[], signal?: AbortSignal) => {
      // 物理注销全局监听器，彻底隔离 Stdin，杜绝回显污染与事件穿透
      this.listener.close();

      if (signal?.aborted) {
        this.listener.start(true);
        return;
      }

      let approvalAbortHandler: (() => void) | undefined;
      const decision = await new Promise<'call' | 'session' | 'persistent' | 'deny'>((resolve) => {
        // 创建临时接口前，显式唤醒 stdin 流，防止之前实例关闭导致流处于暂停状态
        if (typeof process.stdin.resume === 'function') {
          process.stdin.resume();
        }
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });
        // 上游取消时关闭当前审批 UI；ApprovalService 负责撤销对应的挂起审批。
        approvalAbortHandler = () => {
          rl.close();
          resolve('deny');
        };
        signal?.addEventListener('abort', approvalAbortHandler, { once: true });
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

        // 优先使用策略层下发的 choices（任务 5.1、5.2）
        if (choices && choices.length > 0) {
          console.log('选择操作:');
          const choiceMap = new Map<string, ApprovalChoice>();
          choices.forEach((c, i) => {
            const num = i + 1;
            const desc = c.description ? ` — ${c.description}` : '';
            console.log(`  [${num}] ${c.label}${desc}`);
            choiceMap.set(String(num), c);
          });

          const ask = () => {
            rl.question(`请选择 [1-${choices.length}]: `, (answer) => {
              const ans = answer.trim();
              const selected = choiceMap.get(ans);
              if (selected) {
                rl.close();
                resolve(selected.choiceId); // 仅返回 choiceId（任务 5.3）
              } else {
                console.log('无效选择，请重新输入。');
                ask();
              }
            });
          };
          ask();
        } else if (allowedPrefix) {
          // 降级逻辑：choices 缺失时使用 allowedPrefix 推导（任务 5.4）
          console.log('选择操作:');
          console.log('  [1] 单次放行 (Allow Once)');
          console.log(`  [2] 始终放行该前缀命令 (Always Allow "${allowedPrefix}:*")`);
          console.log('  [3] 拒绝执行 (Deny)');

          const ask = () => {
            rl.question('请选择 [1/2/3]: ', (answer) => {
              const ans = answer.trim();
              if (ans === '1') {
                rl.close();
                resolve('call');
              } else if (ans === '2') {
                rl.close();
                resolve('persistent');
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
          // 降级逻辑：无 choices 也无 allowedPrefix（任务 5.4）
          console.log('选择操作:');
          console.log('  [1] 单次放行 (Allow Once)');
          console.log('  [2] 拒绝执行 (Deny)');

          const ask = () => {
            rl.question('请选择 [1/2]: ', (answer) => {
              const ans = answer.trim();
              if (ans === '1') {
                rl.close();
                resolve('call');
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
      if (approvalAbortHandler) {
        signal?.removeEventListener('abort', approvalAbortHandler);
      }

      // Directly return external user decision back to ApprovalService to resume core
      if (!signal?.aborted) {
        this.session.approvalService.resolve(id, { action: decision });
      }

      // Physical rebuild of global listener. Since generation is still busy, keep it paused to prevent stdin capture
      this.listener.start(true);
    });

    // Register browser risk coordination handler
    BrowserSession.userInterventionHandler = async (message: string) => {
      // 1. Pause global InputListener to release stdin
      this.listener.close();
      try {
        // 2. Call CLI specific intervention page
        await waitUserIntervention(message);
      } finally {
        // 3. Rebuild global listener after intervention
        this.listener.start();
      }
    };

    // 订阅大脑层的 agent_event 事件总线，处理流式渲染与异常广播
    this.session.on('agent_event', (event) => {
      this.handleAgentEvent(event);
    });
  }

  /**
   * 启动终端交互 REPL 主循环。
   */
  public start(): void {
    renderSessionHeader(this.session.getModelName(), this.session.getPermissionMode(), this.session.getSessionId());
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
   * 斜杠命令（/ 开头）采用 stdin 独占事务模式：关闭全局监听器 → Clack 菜单独占 stdin → finally 保证重建。
   *
   * @param line - 原始输入文本
   */
  private async handleLineSubmit(line: string): Promise<void> {
    // 防御性保护：agent 生成期间忽略所有输入（存在 check-then-act 竞态，不作为主要 stdin 隔离手段）
    if (this.session.getIsGenerating()) {
      return;
    }

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

    // 3. 交互式菜单激活 + 斜杠指令路由分发 — stdin 独占事务（统一关闭/重建，保证异常安全）
    if (input === '/' || input.startsWith('/')) {
      /** 记录菜单/分发完成后待提交给 handleUserInput 的 LLM 请求 */
      let pendingLLM: { userMessage: string; transientSkillContent?: string } | null = null;

      // 关闭全局监听器，彻底解除 readline 对 stdin 的监听，使后续 Clack 独占 stdin
      this.listener.close();

      try {
        // 若为交互式菜单入口，先解析菜单
        if (input === '/') {
          const menuResult = await showInteractiveMenu();
          if (!menuResult) {
            return; // finally 块会重建 active 监听器
          }
          input = menuResult; // 覆盖原始输入，落入下面的斜杠命令处理
        }

        // 分发斜杠命令，通过 CLI 专用 driving port 访问所需能力
        const cmdResult = await dispatchCommand(input, {
          session: this.session
        });

        // 记录 LLM 请求但不在此执行——LLM 在 finally 恢复监听器之后再执行
        if (cmdResult?.transientSkillContent && cmdResult?.userMessage) {
          pendingLLM = {
            userMessage: cmdResult.userMessage,
            transientSkillContent: cmdResult.transientSkillContent
          };
        }
      } finally {
        // 保证恰好一次重建监听器，无论 try 块正常或异常
        if (pendingLLM) {
          this.listener.start(true);  // paused，由 complete 事件恢复
        } else {
          this.listener.start(false); // 立即 active
        }
      }

      // LLM 请求在 finally 恢复监听器之后执行（不阻塞 stdin 独占事务）
      if (pendingLLM) {
        try {
          this.session.handleUserInput(pendingLLM.userMessage, pendingLLM.transientSkillContent);
        } catch (err) {
          // handleUserInput 同步抛错（如 isGenerating 忙），监听器不能卡在 paused
          const msg = `提交推理失败: ${err instanceof Error ? err.message : String(err)}`;
          logger.error('[CliFacade] handleUserInput 同步抛错', { error: msg });
          console.log(theme.error(`\n[异常] ${msg}\n`));
          this.listener.resume();
        }
      }

      if (input.toLowerCase().startsWith('/resume')) {
        const pendingInteraction = this.session.getPendingInteraction();
        if (pendingInteraction?.state === 'pending') {
          void this.handlePendingInteraction(pendingInteraction);
        }
      }
      return;
    }

    // 5. 常规对话处理
    this.session.handleUserInput(input);
  }

  /**
   * 处理来自大脑层的智能体流式事件。
   * 被动渲染思考过程、内容输出、工具调用以及异常信息。
   *
   * @param event - 大脑层广播的智能体事件
   */
  private handleAgentEvent(event: AgentEvent): void {
    // 检测到一轮新的交互推理开始（CliFacade 处于空闲状态）
    if (!this.isRendering) {
      this.isRendering = true;
      this.hasPrintedReasoning = false;
      this.hasPrintedContent = false;
      this.listener.pause(); // 挂起 Stdin 监听，防人类输入抢占
    }

    switch (event.type) {
      case 'thinking':
        if (!this.hasPrintedReasoning) {
          // 若 content 包含特殊系统通知字样，避免重复输出 [思考过程] 的标题
          if (!event.content.includes('[系统通知]')) {
            process.stdout.write(renderSectionTitle('思考过程'));
          }
          this.hasPrintedReasoning = true;
        }
        process.stdout.write(theme.dim(event.content));
        break;

      case 'content':
        if (!this.hasPrintedContent) {
          if (this.hasPrintedReasoning) process.stdout.write('\n\n');
          this.hasPrintedContent = true;
        }
        process.stdout.write(event.content);
        break;

      case 'tool_call_start':
        process.stdout.write(`\n${renderToolCallStart(event.functionName, event.functionArgs)}\n`);
        break;

      case 'tool_call_result':
        console.log(renderToolCallResult(event.functionName, event.result));
        break;

      case 'interaction_request':
        this.isRendering = false;
        void this.handlePendingInteraction(event.interaction);
        break;

      case 'suspend':
        // 挂起事件，不需要处理（ApprovalHandler 会处理）
        break;

      case 'error':
        console.log(theme.error(`\n[异常] ${event.message}\n`));
        // error 仅作为流内旁注打印，不参与渲染状态管理。complete 是唯一的状态终结点
        break;

      case 'complete':
        console.log(renderCompletionBanner());
        // 渲染 Token 信息和哈希指纹监控面板
        renderTokenPanel(
          this.session.getLastEstimatedUsage(),
          this.session.getLastApiUsage(),
          this.session.getSystemPromptHash(),
          this.session.getLlmConfig()?.contextWindow
        );
        this.isRendering = false;
        this.listener.resume(); // 本轮推理完全结束，恢复 Stdin 监听
        break;
    }
  }

  /**
   * 处理挂起的人机中断提问：拉起 CLI 提问界面，并在回答后恢复原 run。
   * 同一 interactionId 仅允许一个活跃 UI，重复调用被幂等丢弃。
   *
   * @param interaction - 当前挂起的交互记录
   */
  private async handlePendingInteraction(interaction: PendingInteraction): Promise<void> {
    // 幂等去重：同一 interactionId 已在处理时直接返回
    if (this.activeInteractionIds.has(interaction.id)) {
      logger.debug('[CliFacade] handlePendingInteraction 防重跳过', { interactionId: interaction.id });
      return;
    }
    this.activeInteractionIds.add(interaction.id);
    try {
      const answer = await this.interactionHandler.askUser(interaction.payload);
      while (this.session.getIsGenerating()) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await this.session.resumePendingInteraction(interaction.id, answer);
    } catch (error: unknown) {
      const msg = `恢复挂起提问失败: ${error instanceof Error ? error.message : String(error)}`;
      logger.error('[CliFacade] handlePendingInteraction 异常', { error: msg, interactionId: interaction.id });
      console.log(theme.error(`\n[异常] ${msg}\n`));
      if (!this.session.getIsGenerating()) {
        this.listener.resume();
      }
    } finally {
      this.activeInteractionIds.delete(interaction.id);
    }
  }
}
