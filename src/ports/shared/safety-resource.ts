/**
 * @file 端口层共享的安全审批资源类型定义。
 * 将原先在 core 中定义的 SafetyResource 提升至端口层，使 driven port 无需引用 core 类型。
 */

/**
 * 安全审批中涉及的原子资源类型。
 * 每个不安全操作最终归结为对一个或多个原子资源的访问请求。
 */
export type SafetyResource =
  | { kind: 'path'; access: 'read' | 'write'; normalizedPath: string }
  | { kind: 'directory-scope'; access: 'read'; normalizedPath: string }
  | { kind: 'command-prefix'; prefix: string };
