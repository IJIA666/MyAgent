/* eslint-disable n/no-process-env */
import { chromium, BrowserContext, Page } from 'playwright';
import { BrowserDetector } from './browser-detector.js';
import { resolve } from 'path';
import readline from 'readline';
import type { NativeTool, SafetyCheckResult } from '../../virtual-mcp.js';

/**
 * 浏览器会话生命周期管理类。
 * 核心职责：
 * 1. 负责 Playwright 浏览器上下文（BrowserContext）和活动页面（Page）的创建与单例复用；
 * 2. 处理 CDP 连接模式与 launchPersistentContext 的本地会话持久化切换；
 * 3. 实现数据状态清理与优雅关闭。
 */
export class BrowserSession {
  private static context: BrowserContext | null = null;
  private static page: Page | null = null;

  /** 允许注册的命令行阻塞拦截干预回调函数 */
  public static userInterventionHandler: ((message: string) => Promise<void>) | null = null;

  /**
   * 获取或初始化当前的浏览器页面（Page）实例。
   *
   * @param cdpUrl - 可选的远程调试端口地址（如 http://127.0.0.1:9222），若提供则直接通过 connectOverCDP 直连
   * @returns 正在运行的 Playwright Page 实例
   */
  public static async getPage(cdpUrl?: string): Promise<Page> {
    if (this.page && !this.page.isClosed()) {
      return this.page;
    }

    // 执行环境清理以防残留
    await this.close();

    if (cdpUrl) {
      // 1. 直连现有 Chrome 的 CDP 调试通道
      const browser = await chromium.connectOverCDP(cdpUrl);
      const contexts = browser.contexts();
      let activePage = contexts[0]?.pages()[0];
      if (!activePage) {
        const ctx = contexts[0] || await browser.newContext();
        activePage = await ctx.newPage();
      }
      this.page = activePage;
      this.context = activePage.context();
    } else {
      // 2. 本地持久化上下文通道
      const userDataDir = process.env.BROWSER_USER_DATA_DIR || resolve(process.cwd(), '.myagent/browser-session');
      const executablePath = BrowserDetector.detectExecutablePath() || undefined;
      const isHeadless = process.env.BROWSER_HEADLESS !== 'false';

      this.context = await chromium.launchPersistentContext(userDataDir, {
        executablePath,
        headless: isHeadless,
        viewport: { width: 1280, height: 800 }
      });
      
      const activePage = this.context.pages()[0] || await this.context.newPage();
      this.page = activePage;
    }

    return this.page;
  }

  /**
   * 关闭当前的浏览器实例与会话，释放所有的底层物理流资源。
   */
  public static async close(): Promise<void> {
    if (this.page) {
      try {
        await this.page.close();
      } catch {
        // 忽略关闭异常
      }
      this.page = null;
    }
    if (this.context) {
      try {
        await this.context.close();
      } catch {
        // 忽略关闭异常
      }
      this.context = null;
    }
  }
}

/**
 * 在页面中重新编排可交互元素，给它们依次打上 data-myagent-id="eN" 的临时标签，
 * 并返回一个精简的可交互元素信息树（以文本形式）。
 *
 * @param page - 运行 Playwright 的 Page 实例
 * @returns 格式化后的网页文本 Snapshot
 */
export async function generateAriaSnapshot(page: Page): Promise<string> {
  return await page.evaluate(() => {
    // 1. 先清除之前打上的所有临时标签
    const oldElements = document.querySelectorAll('[data-myagent-id]');
    for (let i = 0; i < oldElements.length; i++) {
      oldElements[i].removeAttribute('data-myagent-id');
    }

    // 2. 定义可交互元素的标签与属性选择器
    const interactiveSelectors = [
      'a', 'button', 'input', 'select', 'textarea',
      '[role="button"]', '[role="link"]', '[role="checkbox"]',
      '[role="tab"]', '[onclick]'
    ].join(',');

    const allCandidates = Array.from(document.querySelectorAll(interactiveSelectors));
    let count = 1;
    const treeLines: string[] = [];

    // 3. 遍历候选元素，打标签并提炼文本（使用原生 for 循环，彻底规避嵌套函数）
    for (let i = 0; i < allCandidates.length; i++) {
      const htmlEl = allCandidates[i] as HTMLElement;

      // ---- 内联的可见性校验逻辑 ----
      if (!htmlEl.getBoundingClientRect) {
        continue;
      }
      const rect = htmlEl.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        continue;
      }
      const style = window.getComputedStyle(htmlEl);
      if (style.display === 'none' || style.visibility === 'hidden') {
        continue;
      }
      // 检查其所有祖辈节点是否被隐藏
      let parent = htmlEl.parentElement;
      let isParentHidden = false;
      while (parent) {
        const pStyle = window.getComputedStyle(parent);
        if (pStyle.display === 'none' || pStyle.visibility === 'hidden') {
          isParentHidden = true;
          break;
        }
        parent = parent.parentElement;
      }
      if (isParentHidden) {
        continue;
      }
      // ----------------------------

      const id = `e${count}`;
      htmlEl.setAttribute('data-myagent-id', id);
      count++;

      // 提取元素的文本语义描述
      const tagName = htmlEl.tagName.toLowerCase();
      let typeName = '元素';
      let info = '';

      if (tagName === 'a' || htmlEl.getAttribute('role') === 'link') {
        typeName = '链接';
        info = htmlEl.innerText.trim() || htmlEl.getAttribute('aria-label')?.trim() || htmlEl.title || '未命名链接';
      } else if (tagName === 'button' || htmlEl.getAttribute('role') === 'button') {
        typeName = '按钮';
        info = htmlEl.innerText.trim() || htmlEl.getAttribute('aria-label')?.trim() || htmlEl.title || '未命名按钮';
      } else if (tagName === 'input') {
        const inputEl = htmlEl as HTMLInputElement;
        typeName = `输入框(${inputEl.type})`;
        info = inputEl.placeholder?.trim() || inputEl.name || inputEl.getAttribute('aria-label')?.trim() || '';
        if (inputEl.value) {
          info += ` (当前值: ${inputEl.value})`;
        }
      } else if (tagName === 'textarea') {
        const textEl = htmlEl as HTMLTextAreaElement;
        typeName = '文本域';
        info = textEl.placeholder?.trim() || textEl.name || '';
        if (textEl.value) {
          info += ` (当前值: ${textEl.value})`;
        }
      } else if (tagName === 'select') {
        const selectEl = htmlEl as HTMLSelectElement;
        typeName = '下拉框';
        info = selectEl.name || '';
        const selected = Array.from(selectEl.selectedOptions).map(o => o.text).join(',');
        if (selected) {
          info += ` (当前选中: ${selected})`;
        }
      }

      // 计算元素的相对 DOM 缩进（深度分析）
      let depth = 0;
      let indentParent = htmlEl.parentElement;
      while (indentParent && indentParent !== document.body) {
        depth++;
        indentParent = indentParent.parentElement;
      }
      const indent = '  '.repeat(Math.min(depth, 4));

      treeLines.push(`${indent}[${typeName}] [@${id}] ${info}`);
    }

    // 4. 组合当前页面的核心元数据与树结构
    const title = document.title || '无标题网页';
    const url = window.location.href;
    const header = `【网页标题】：${title}\n【网页链接】：${url}\n【可交互元素快照清单】：\n`;

    return treeLines.length > 0
      ? header + treeLines.join('\n')
      : header + '（未探测到任何可见的可交互元素）';
  });
}

/**
 * 网页导航跳转工具类。
 * 负责实例化浏览器并执行目标页面跳转，完成后自动返回带编号的 DOM 树快照。
 */
export class BrowserNavigateTool implements NativeTool {
  readonly securityCategory = 'write';
  readonly name = 'browser_navigate';
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'browser_navigate',
      description: "在浏览器中导航到指定的 URL。必须在执行其它浏览器交互操作前优先调用此工具。如果配置了 CDP URL，将直连该地址，否则采用本地持久化 Profile 会话。",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "要导航的目标网址，例如 'https://example.com'。"
          },
          cdpUrl: {
            type: "string",
            description: "远程调试端口地址（可选，例如 'http://127.0.0.1:9222'，若传入则直连该运行中的浏览器实例）。"
          }
        },
        required: ["url"]
      }
    }
  };

  /**
   * 审查网页跳转操作的安全性。
   *
   * @param _args - 工具参数字典
   * @returns 安全审查结论，直接放行
   */
  checkSafety(_args: Record<string, unknown>): SafetyCheckResult {
    void _args;
    return { status: 'pass' };
  }

  /**
   * 执行网页导航跳转。
   *
   * @param args - 参数字典
   * @returns 导航跳转完毕后的精简元素标号快照
   */
  async execute(args: Record<string, unknown>): Promise<string> {
    const url = args.url;
    const cdpUrl = typeof args.cdpUrl === 'string' ? args.cdpUrl : process.env.BROWSER_CDP_URL;
    if (typeof url !== 'string') {
      throw new Error("url 必须是字符串");
    }

    const page = await BrowserSession.getPage(cdpUrl);
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    return await generateAriaSnapshot(page);
  }
}

/**
 * 网页元素点击动作工具类。
 * 负责反射对应的 DOM 节点元素并执行 click 点击。
 */
export class BrowserClickTool implements NativeTool {
  readonly securityCategory = 'write';
  readonly name = 'browser_click';
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'browser_click',
      description: "点击网页中指定的带有标号的元素（例如 '@e5'）。标号对应之前页面快照输出中的 [@eN] 项。调用此工具前必须已调用 browser_navigate。",
      parameters: {
        type: "object",
        properties: {
          ref: {
            type: "string",
            description: "目标元素的编号标识（例如 '@e5' 或 'e5'）。"
          }
        },
        required: ["ref"]
      }
    }
  };

  checkSafety(_args: Record<string, unknown>): SafetyCheckResult {
    void _args;
    return { status: 'pass' };
  }

  /**
   * 执行网页元素点击操作。
   *
   * @param args - 参数字典
   * @returns 点击执行完毕并等待 1 秒后的最新页面编号快照
   */
  async execute(args: Record<string, unknown>): Promise<string> {
    const ref = args.ref;
    if (typeof ref !== 'string') {
      throw new Error("ref 必须是字符串");
    }
    const cleanId = ref.replace('@', '').trim();
    const selector = `[data-myagent-id="${cleanId}"]`;

    const page = await BrowserSession.getPage();
    const element = await page.$(selector);
    if (!element) {
      throw new Error(`未找到编号为 "${ref}" 的元素。请确认之前获取的网页快照中包含此编号，或者页面是否已经发生变化。`);
    }

    await element.click({ timeout: 10000 });
    await page.waitForTimeout(1000);
    return await generateAriaSnapshot(page);
  }
}

/**
 * 网页输入框填充工具类。
 * 负责在指定的输入框打字前先执行清空操作，防范重复输入。
 */
export class BrowserTypeTool implements NativeTool {
  readonly securityCategory = 'write';
  readonly name = 'browser_type';
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'browser_type',
      description: "在网页中的输入框中输入文本。输入前会自动清空输入框。调用此工具前必须已调用 browser_navigate。",
      parameters: {
        type: "object",
        properties: {
          ref: {
            type: "string",
            description: "目标输入框的编号标识（例如 '@e3'）。"
          },
          text: {
            type: "string",
            description: "要输入的文本内容。"
          }
        },
        required: ["ref", "text"]
      }
    }
  };

  checkSafety(_args: Record<string, unknown>): SafetyCheckResult {
    void _args;
    return { status: 'pass' };
  }

  /**
   * 执行输入框的文本填入操作。
   *
   * @param args - 参数字典
   * @returns 输入完成后最新页面快照
   */
  async execute(args: Record<string, unknown>): Promise<string> {
    const ref = args.ref;
    const text = args.text;
    if (typeof ref !== 'string') {
      throw new Error("ref 必须是字符串");
    }
    if (typeof text !== 'string') {
      throw new Error("text 必须是字符串");
    }
    const cleanId = ref.replace('@', '').trim();
    const selector = `[data-myagent-id="${cleanId}"]`;

    const page = await BrowserSession.getPage();
    const element = await page.$(selector);
    if (!element) {
      throw new Error(`未找到编号为 "${ref}" 的输入框元素。`);
    }

    await element.focus();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await element.fill(text);

    await page.waitForTimeout(500);
    return await generateAriaSnapshot(page);
  }
}

/**
 * 网页视口滚动工具类。
 * 负责在浏览器中向上或向下滚动半个屏幕左右距离，以显露滚动条外部元素。
 */
export class BrowserScrollTool implements NativeTool {
  readonly securityCategory = 'write';
  readonly name = 'browser_scroll';
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'browser_scroll',
      description: "上下滚动网页，以便查看视口外隐藏的其它内容。调用此工具前必须已调用 browser_navigate。",
      parameters: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            enum: ["up", "down"],
            description: "滚动的方向（'up' 表示向上滚动，'down' 表示向下滚动）。"
          }
        },
        required: ["direction"]
      }
    }
  };

  checkSafety(_args: Record<string, unknown>): SafetyCheckResult {
    void _args;
    return { status: 'pass' };
  }

  /**
   * 执行视口滚动。
   *
   * @param args - 参数字典
   * @returns 滚动后的网页快照
   */
  async execute(args: Record<string, unknown>): Promise<string> {
    const direction = args.direction;
    if (direction !== 'up' && direction !== 'down') {
      throw new Error("direction 必须是 'up' 或 'down'");
    }

    const page = await BrowserSession.getPage();
    await page.evaluate((dir) => {
      const scrollHeight = window.innerHeight * 0.8;
      window.scrollBy(0, dir === 'up' ? -scrollHeight : scrollHeight);
    }, direction);

    await page.waitForTimeout(500);
    return await generateAriaSnapshot(page);
  }
}

/**
 * 历史记录后退工具类。
 * 负责在浏览器历史会话中后退一级。
 */
export class BrowserBackTool implements NativeTool {
  readonly securityCategory = 'write';
  readonly name = 'browser_back';
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'browser_back',
      description: "在浏览器的历史记录中后退一步。调用此工具前必须已调用 browser_navigate。",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  };

  checkSafety(_args: Record<string, unknown>): SafetyCheckResult {
    void _args;
    return { status: 'pass' };
  }

  /**
   * 执行浏览器后退指令。
   *
   * @returns 后退完成后的最新网页快照
   */
  async execute(): Promise<string> {
    const page = await BrowserSession.getPage();
    await page.goBack({ timeout: 10000 });
    await page.waitForTimeout(1000);
    return await generateAriaSnapshot(page);
  }
}

/**
 * 按键模拟工具类。
 * 提供向页面键盘接口直接注入按键（如 Enter、Tab 等）以进行表单提交的指令。
 */
export class BrowserPressTool implements NativeTool {
  readonly securityCategory = 'write';
  readonly name = 'browser_press';
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'browser_press',
      description: "在浏览器中模拟按下物理键盘的某一个按键（如 'Enter'，'Tab'，'ArrowDown' 等）。调用此工具前必须已调用 browser_navigate。",
      parameters: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "要按下的物理按键名称（如 'Enter'，'Tab'，'Backspace'，'ArrowDown'）。"
          }
        },
        required: ["key"]
      }
    }
  };

  checkSafety(_args: Record<string, unknown>): SafetyCheckResult {
    void _args;
    return { status: 'pass' };
  }

  /**
   * 模拟按键下压。
   *
   * @param args - 参数字典
   * @returns 状态反馈快照
   */
  async execute(args: Record<string, unknown>): Promise<string> {
    const key = args.key;
    if (typeof key !== 'string') {
      throw new Error("key 必须是字符串");
    }

    const page = await BrowserSession.getPage();
    await page.keyboard.press(key);
    await page.waitForTimeout(500);
    return await generateAriaSnapshot(page);
  }
}

/**
 * 浏览器截图核验与视觉分析工具类。
 * 提供对当前浏览器页面截取图片物理落盘，并在指定时为页面元素绘制红线外框。
 */
export class BrowserVisionTool implements NativeTool {
  readonly securityCategory = 'write';
  readonly name = 'browser_vision';
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'browser_vision',
      description: "对当前浏览器页面截图并进行安全保存，主要用于视觉比对、人机风控核验或验证码识别。返回保存截图的物理绝对路径。",
      parameters: {
        type: "object",
        properties: {
          annotate: {
            type: "boolean",
            description: "是否为页面元素添加红边框和编号标记（用于调试核验，默认为 false）。"
          }
        }
      }
    }
  };

  checkSafety(_args: Record<string, unknown>): SafetyCheckResult {
    void _args;
    return { status: 'pass' };
  }

  /**
   * 执行截图操作。
   *
   * @param args - 参数字典
   * @returns 截图物理落盘后的存放路径说明
   */
  async execute(args: Record<string, unknown>): Promise<string> {
    const page = await BrowserSession.getPage();
    const annotate = typeof args.annotate === 'boolean' ? args.annotate : false;

    // 建立专用的临时截图存放目录
    const screenshotsDir = resolve(process.cwd(), '.myagent/screenshots');
    const { mkdirSync, existsSync } = await import('fs');
    if (!existsSync(screenshotsDir)) {
      mkdirSync(screenshotsDir, { recursive: true });
    }

    const filename = `screenshot_${Date.now()}.png`;
    const screenshotPath = resolve(screenshotsDir, filename);

    if (annotate) {
      // 可以在页面上绘制红框编号标记，以辅助视觉识别
      await page.evaluate(() => {
        const elements = document.querySelectorAll('[data-myagent-id]');
        elements.forEach((el) => {
          const htmlEl = el as HTMLElement;
          const rect = htmlEl.getBoundingClientRect();
          const badge = document.createElement('div');
          badge.style.position = 'absolute';
          badge.style.border = '2px solid red';
          badge.style.left = `${rect.left + window.scrollX}px`;
          badge.style.top = `${rect.top + window.scrollY}px`;
          badge.style.width = `${rect.width}px`;
          badge.style.height = `${rect.height}px`;
          badge.style.pointerEvents = 'none';
          badge.style.zIndex = '99999';
          badge.setAttribute('data-myagent-badge', 'true');
          
          const text = document.createElement('span');
          text.style.backgroundColor = 'red';
          text.style.color = 'white';
          text.style.fontSize = '10px';
          text.style.padding = '2px';
          text.innerText = htmlEl.getAttribute('data-myagent-id') || '';
          
          badge.appendChild(text);
          document.body.appendChild(badge);
        });
      });
    }

    // 截图物理落盘
    await page.screenshot({ path: screenshotPath, fullPage: false });

    if (annotate) {
      // 截图完成后，移除这些红边框
      await page.evaluate(() => {
        const badges = document.querySelectorAll('[data-myagent-badge]');
        badges.forEach(b => b.remove());
      });
    }

    return `页面截图已成功保存到物理绝对路径："${screenshotPath}"。您可以通过该图片来进行视觉风控核准。`;
  }
}

/**
 * 阻塞当前异步逻辑，在控制台打印高亮提示信息，等待用户完成手动浏览器操作并在命令行按下回车键后释放。
 * 针对 Readline 实例和 process.stdin 状态进行安全管控，防范流泄露和死锁。
 *
 * @param message - 要在终端展示的提示性文本
 * @returns 异步 Promise，在用户回车后 resolve
 */
export function waitUserIntervention(message: string): Promise<void> {
  return new Promise<void>((resolve) => {
    // 打印清晰的黄色高亮指示
    console.log(`\n\x1b[33m⚠️  [人机风控协作] ${message}\x1b[0m`);

    // 建立临时的独立 Readline 接口实例
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question('   👉  已完成手动操作？按【回车键/Enter】以确认并继续智能体自动操作：', () => {
      // 1. 物理注销 Readline 实例，释放其对 stdin 的流占用
      rl.close();

      // 2. 显式对 stdin 执行 pause 以释放事件监听，防止与主 REPL 抢夺流
      if (process.stdin.isTTY) {
        process.stdin.pause();
      }

      console.log('\x1b[32m✔ 状态同步完成，智能体继续执行...\x1b[0m\n');
      resolve();
    });
  });
}

/**
 * 人机风控与扫码登录协作工具类。
 * 核心职责：
 * 1. 当检测到页面处于登录、风控验证状态时，挂起智能体执行，调起有头浏览器窗口；
 * 2. 终端打印黄色高亮卡关提示，同步阻塞等待用户在弹窗中手动扫码/输入验证码；
 * 3. 待用户回车确认后释放阻塞，刷新并同步最新快照状态，供智能体继续执行。
 */
export class BrowserEnsureLoginTool implements NativeTool {
  readonly securityCategory = 'write';
  readonly name = 'browser_ensure_login';
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'browser_ensure_login',
      description: "检验并确保目标网站处于已登录状态。若发现当前需要登录、过滑动验证码或人机校验，将调起有头窗口并挂起智能体推理，等待用户在弹出的浏览器中手动完成登录或过风控。用户回车后同步会话状态继续执行。",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "说明为什么调用此工具（例如：发现页面有登录表单或滑块验证码）。"
          }
        },
        required: []
      }
    }
  };

  checkSafety(_args: Record<string, unknown>): SafetyCheckResult {
    void _args;
    return { status: 'pass' };
  }

  /**
   * 执行人机协作登录阻塞等待。
   *
   * @param args - 参数字典
   * @returns 登录完毕并释放阻塞后的最新页面标号快照
   */
  async execute(args: Record<string, unknown>): Promise<string> {
    const reason = typeof args.reason === 'string' ? args.reason : '检测到需要人机登录验证';
    
    // 1. 获取当前页面实例
    let page = await BrowserSession.getPage();

    // 2. 如果当前是无头模式（headless），我们需要以有头模式重建浏览器以供用户手动操作
    const isHeadless = process.env.BROWSER_HEADLESS !== 'false';
    const cdpUrl = process.env.BROWSER_CDP_URL;
    
    if (isHeadless && !cdpUrl) {
      // 备份当前 URL
      const currentUrl = page.url();
      console.log('\n[人机协作] 正在以有头窗口重新调起浏览器，请稍候...');
      
      // 临时开启有头模式
      process.env.BROWSER_HEADLESS = 'false';
      page = await BrowserSession.getPage();
      
      // 导航到先前的页面
      if (currentUrl && currentUrl !== 'about:blank') {
        await page.goto(currentUrl, { waitUntil: 'load', timeout: 30000 });
      }
    }

    // 3. 执行终端命令行阻塞等待用户手动处理
    const promptMsg = `${reason}。已调起有头浏览器窗口，请在弹出的界面中完成登录、扫码或滑动验证操作。`;
    if (BrowserSession.userInterventionHandler) {
      await BrowserSession.userInterventionHandler(promptMsg);
    } else {
      await waitUserIntervention(promptMsg);
    }

    // 4. 恢复 headless 原始配置（如果之前有临时更改的话）
    if (isHeadless && !cdpUrl) {
      delete process.env.BROWSER_HEADLESS;
    }

    // 5. 阻塞释放后，刷新并生成最新快照返回给智能体
    return await generateAriaSnapshot(page);
  }
}
