/**
 * 终端键盘与输入控制监听器。
 * 核心职责：
 * 1. 负责创建与销毁 readline.Interface 实例，维系输入流 REPL 循环；
 * 2. 拦截并处理 Ctrl+C、双击 ESC 等底层按键动作，并提供二次回滚确认交互；
 * 3. 动态渲染输入提示符，以无状态回调方式向外派发事件流。
 */

import { createInterface } from 'readline';
import { theme } from '../views/theme.js';
import { renderPromptPrefix } from '../views/widget-renderer.js';

/**
 * 实例化 InputListener 必须传入的配置与回调接口。
 */
export interface InputListenerOptions {
  /** 动态获取当前是否在推理生成状态的 Getter */
  getIsGenerating: () => boolean;
  /** 动态获取当前激活的模型名称以刷新提示符的 Getter */
  getModelName: () => string;
  /** 动态获取当前工作安全模式的 Getter */
  getWorkMode: () => string;
  /** 当处于生成状态双击 ESC 时的中断回调 */
  onAbort: () => void;
  /** 当处于非生成状态双击 ESC 并确认撤销时的回滚回调 */
  onRollback: () => void;
  /** 当用户提交一整行有效控制台输入时的提交回调 */
  onLineSubmit: (line: string) => void;
  /** 可选注入的输入流，测试时使用隔离的 Mock 流，默认回退至 process.stdin */
  input?: NodeJS.ReadableStream;
  /** 可选注入的输出流，测试时使用隔离的 Mock 流，默认回退至 process.stdout */
  output?: NodeJS.WritableStream;
}

/**
 * 终端键盘与输入控制监听器。
 * 专门收拢 readline 实例、键盘按键绑定、退出指令以及快捷键的事件流监听。
 */
export class InputListener {
  /** 内部维护的 active readline 接口实例 */
  private rl: ReturnType<typeof createInterface> | null = null;
  /** 当前监听器是否处于挂起暂停状态，物理隔离多路复用 Stdin 被意外唤醒后的 line 事件穿透 */
  private isPaused = false;
  /** 实际使用的输入流，默认 process.stdin */
  private inputStream: NodeJS.ReadableStream;
  /** 实际使用的输出流，默认 process.stdout */
  private outputStream: NodeJS.WritableStream;
  /** 获取当前是否生成中的 Getter 回调 */
  private isGenerating: () => boolean;
  /** 获取当前模型名称的 Getter 回调 */
  private getModelName: () => string;
  /** 获取当前工作安全模式的 Getter 回调 */
  private getWorkMode: () => string;
  /** 中断回调 */
  private onAbort: () => void;
  /** 回滚回调 */
  private onRollback: () => void;
  /** 提交行回调 */
  private onLineSubmit: (line: string) => void;

  /** 上次按下 ESC 的毫秒时间戳，用于双击判定 */
  private lastEscapeTime = 0;
  /** 按键事件的处理器引用，确保 add/removeListener 指向同一引用 */
  private keypressHandler: (str: string, key: { name?: string }) => void;
  /** 缓存的历史命令记录数组，保障 rl 实例销毁重组时记忆不丢失 */
  private commandHistory: string[] = [];
  /**
   * 单调递增的恢复版本号，用于使过期 setImmediate 回调失效。
   * pause() 和 close() 递增该值；resume() 的 setImmediate 回调捕获创建时版本，
   * 执行时与当前版本比较，不匹配则跳过恢复。
   */
  private resumeVersion = 0;
  /**
   * 单调递增的 readline 实例 ID，用于使旧 readline 的延迟 line 事件失效。
   * start() 创建新 rl 前递增；close() 递增；line 回调闭包捕获创建时 ID，
   * 执行时与当前 ID 比较，不匹配则直接丢弃事件。
   */
  private rlInstanceId = 0;

  /**
   * 构造函数，绑定 Getter 属性与事件回调。
   * @param options 初始化选项配置
   */
  constructor(options: InputListenerOptions) {
    this.isGenerating = options.getIsGenerating;
    this.getModelName = options.getModelName;
    this.getWorkMode = options.getWorkMode;
    this.onAbort = options.onAbort;
    this.onRollback = options.onRollback;
    this.onLineSubmit = options.onLineSubmit;
    this.inputStream = options.input || process.stdin;
    this.outputStream = options.output || process.stdout;

    this.keypressHandler = (str, key) => this.handleKeyPress(str, key);
  }

  /**
   * 幂等注册 keypress 监听器。先移除再添加，确保同一时间只存在一个实例。
   */
  private attachKeypressHandler(): void {
    this.inputStream.removeListener('keypress', this.keypressHandler);
    this.inputStream.on('keypress', this.keypressHandler);
  }

  /**
   * 移除 keypress 监听器。
   */
  private detachKeypressHandler(): void {
    this.inputStream.removeListener('keypress', this.keypressHandler);
  }

  /**
   * 初始化并启动基于 stdin/stdout 的交互监听。
   *
   * @param paused - 是否在重建后立即保持挂起暂停状态，默认不挂起
   */
  public start(paused = false): void {
    this.isPaused = paused;
    // 递增 rlInstanceId，使之前所有 line 回调失效
    this.rlInstanceId++;
    const instanceId = this.rlInstanceId; // 闭包捕获当前 ID
    try {
      // 在恢复或启动时，如果有被 pause 挂起的流，且不需要保持暂停，显式执行 resume 唤醒以恢复正常读取
      const stream = this.inputStream as unknown as { resume?: () => void };
      if (!paused && typeof stream.resume === 'function') {
        stream.resume();
      }
      // 在创建新 readline 之前，同步排空物理输入流中所有积压的数据，防止重建后的积压数据溢出
      while (this.inputStream.read() !== null);
    } catch {
      // 容错
    }
    const completer = (line: string) => {
      if (line.startsWith('/')) {
        const commands = ['/model', '/rollback', '/help', '/history', '/resume', '/mcp', '/tool', '/skill'];
        const hits = commands.filter((c) => c.startsWith(line));
        return [hits.length ? hits : [], line];
      }
      return [[], line];
    };

    this.rl = createInterface({
      input: this.inputStream,
      output: this.outputStream,
      completer: completer,
      history: this.commandHistory
    });

    this.updatePrompt();

    // 绑定回车提交监听，在挂起期间物理拦截并强行丢弃共享 Stdin 导致的任何残留回车
    // 同时通过 instanceId 拦截旧 readline 实例的延迟 line 事件
    this.rl.on('line', (line) => {
      if (instanceId !== this.rlInstanceId) {
        return; // 旧 readline 实例的延迟事件，直接丢弃
      }
      if (this.isPaused) {
        return;
      }
      this.onLineSubmit(line);
    });

    // 绑定 Ctrl+C 信号监听，安全释放流并退出
    this.rl.on('SIGINT', () => {
      console.log(`\n${theme.success('[系统] 收到中断信号，程序退出。')}`);
      this.close();
      process.exit(0);
    });

    // 只有 active 状态才注册 keypress 监听；paused 状态暂不监听，由后续 resume() 统一注册
    if (!paused) {
      this.attachKeypressHandler();
    }

    // 尊重挂起状态：若当前处于挂起状态则不主动展示提示符，否则正常展示
    if (this.isPaused) {
      this.rl.pause();
    } else {
      this.rl.prompt();
    }
  }

  /**
   * 动态刷新提示符前缀。
   */
  public updatePrompt(): void {
    if (this.rl) {
      this.rl.setPrompt(renderPromptPrefix(this.getModelName(), this.getWorkMode()));
    }
  }

  /**
   * 唤醒并呈现控制台输入行。
   */
  public prompt(): void {
    if (this.rl) {
      this.rl.prompt();
    }
  }

  /**
   * 暂时挂起输入监听。
   * 当调起 @clack/prompts 等独占 stdin 的第三方菜单或进行人机审批交互时，必须调用此方法释放监听。
   */
  public pause(): void {
    this.isPaused = true;
    this.resumeVersion++;
    if (this.rl) {
      this.rl.pause();
    }
    this.detachKeypressHandler();
  }

  /**
   * 从挂起中恢复输入监听。
   */
  public resume(): void {
    try {
      // 恢复监听前，若流被 pause 挂起，显式执行 resume 唤醒
      const stream = this.inputStream as unknown as { resume?: () => void };
      if (typeof stream.resume === 'function') {
        stream.resume();
      }
      // 在恢复监听之前，物理同步排空流中所有挂起期间意外积压的垃圾输入，以保持缓冲区物理洁净
      while (this.inputStream.read() !== null);
    } catch {
      // 容错
    }
    if (this.rl) {
      this.rl.resume();
    }
    this.attachKeypressHandler();
    this.updatePrompt();
    this.prompt();

    // 捕获当前版本号，回调执行时比较以防止过期回调覆盖 isPaused
    const versionAtResume = this.resumeVersion;
    setImmediate(() => {
      if (versionAtResume !== this.resumeVersion) {
        return; // 有更新的 pause/close 发生，此回调已过期
      }
      this.isPaused = false;
    });
  }

  /**
   * 物理注销当前 active 的 readline 实例并注销所有监听。
   */
  public close(): void {
    this.isPaused = true;
    this.rlInstanceId++;
    this.resumeVersion++;
    if (this.rl) {
      // 显式解绑旧 line handler，防止 rl.close() 后排队事件仍触发
      this.rl.removeAllListeners('line');
      // 备份历史记录，防止实例物理销毁时记忆丢失
      const hist = (this.rl as unknown as { history?: string[] }).history;
      if (Array.isArray(hist)) {
        this.commandHistory = [...hist];
      }
      this.rl.close();
      this.rl = null;
    }
    this.detachKeypressHandler();
  }

  /**
   * 暴露内部 readline 实例，以便门面在特殊场景下（如二次询问）委托复用。
   */
  public getInterface(): ReturnType<typeof createInterface> | null {
    return this.rl;
  }

  /**
   * 键盘底层按键拦截器。
   */
  private handleKeyPress(str: string, key: { name?: string }): void {
    if (key && key.name === 'escape') {
      const now = Date.now();
      if (now - this.lastEscapeTime < 500) {
        // 双击 ESC 成立
        this.triggerEscDoublePress();
        this.lastEscapeTime = 0;
      } else {
        this.lastEscapeTime = now;
      }
    }
  }

  /**
   * 执行双击 ESC 之后的流控制转移决策。
   */
  private triggerEscDoublePress(): void {
    if (this.isGenerating()) {
      // 生成推理中，触发中止
      this.onAbort();
    } else {
      // 非生成状态，询问是否撤销
      if (!this.rl) return;

      // 抹除当前输入行的残留
      this.outputStream.write('\r' + ' '.repeat(50) + '\r');
      // 物理注销以防 Stdin 共享回显污染
      this.close();

      const tempRl = createInterface({
        input: this.inputStream,
        output: this.outputStream
      });

      tempRl.question(theme.highlight('\n[系统] 确定要撤销上一轮对话吗？(y/N) > '), (answer) => {
        tempRl.close();
        if (answer.toLowerCase() === 'y') {
          this.onRollback();
        } else {
          console.log(theme.dim('[系统] 已取消回滚。'));
        }
        // 物理重建并启动常规监听
        this.start();
      });
    }
  }
}
