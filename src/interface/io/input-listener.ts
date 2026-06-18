/**
 * 终端键盘与输入控制监听器。
 * 核心职责：
 * 1. 负责创建与销毁 readline.Interface 实例，维系输入流 REPL 循环；
 * 2. 拦截并处理 Ctrl+C、双击 ESC 等底层按键动作，并提供二次回滚确认交互；
 * 3. 动态渲染输入提示符，以无状态回调方式向外派发事件流。
 */

import { createInterface } from 'readline';
import { theme } from '../../utils/theme.js';

/**
 * 实例化 InputListener 必须传入的配置与回调接口。
 */
export interface InputListenerOptions {
  /** 动态获取当前是否在推理生成状态的 Getter */
  getIsGenerating: () => boolean;
  /** 动态获取当前激活的模型名称以刷新提示符的 Getter */
  getModelName: () => string;
  /** 当处于生成状态双击 ESC 时的中断回调 */
  onAbort: () => void;
  /** 当处于非生成状态双击 ESC 并确认撤销时的回滚回调 */
  onRollback: () => void;
  /** 当用户提交一整行有效控制台输入时的提交回调 */
  onLineSubmit: (line: string) => void;
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
  /** 获取当前是否生成中的 Getter 回调 */
  private isGenerating: () => boolean;
  /** 获取当前模型名称的 Getter 回调 */
  private getModelName: () => string;
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
   * 构造函数，绑定 Getter 属性与事件回调。
   * @param options 初始化选项配置
   */
  constructor(options: InputListenerOptions) {
    this.isGenerating = options.getIsGenerating;
    this.getModelName = options.getModelName;
    this.onAbort = options.onAbort;
    this.onRollback = options.onRollback;
    this.onLineSubmit = options.onLineSubmit;

    this.keypressHandler = (str, key) => this.handleKeyPress(str, key);
  }

  /**
   * 初始化并启动基于 stdin/stdout 的交互监听。
   */
  public start(): void {
    this.isPaused = false;
    const completer = (line: string) => {
      if (line.startsWith('/')) {
        const commands = ['/model', '/rollback', '/help', '/history', '/resume', '/mcp', '/tool', '/skill'];
        const hits = commands.filter((c) => c.startsWith(line));
        return [hits.length ? hits : [], line];
      }
      return [[], line];
    };

    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      completer: completer,
      history: this.commandHistory
    });

    this.updatePrompt();

    // 绑定回车提交监听，在挂起期间物理拦截并强行丢弃共享 Stdin 导致的任何残留回车
    this.rl.on('line', (line) => {
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

    // 监听底层按键以捕捉全局 ESC 按键
    process.stdin.on('keypress', this.keypressHandler);

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
      this.rl.setPrompt(theme.info(`用户 [${this.getModelName()}] > `));
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
    if (this.rl) {
      this.rl.pause();
    }
    process.stdin.removeListener('keypress', this.keypressHandler);
  }

  /**
   * 从挂起中恢复输入监听。
   */
  public resume(): void {
    this.isPaused = false;
    if (this.rl) {
      this.rl.resume();
    }
    process.stdin.on('keypress', this.keypressHandler);
    this.updatePrompt();
    this.prompt();
  }

  /**
   * 物理注销当前 active 的 readline 实例并注销所有监听。
   */
  public close(): void {
    if (this.rl) {
      // 备份历史记录，防止实例物理销毁时记忆丢失
      const hist = (this.rl as unknown as { history?: string[] }).history;
      if (Array.isArray(hist)) {
        this.commandHistory = [...hist];
      }
      this.rl.close();
      this.rl = null;
    }
    process.stdin.removeListener('keypress', this.keypressHandler);
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
      process.stdout.write('\r' + ' '.repeat(50) + '\r');
      // 物理注销以防 Stdin 共享回显污染
      this.close();

      const tempRl = createInterface({
        input: process.stdin,
        output: process.stdout
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
