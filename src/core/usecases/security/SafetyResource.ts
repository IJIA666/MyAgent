/**
 * 安全审批中涉及的原子资源类型定义。
 * 每个不安全操作最终归结为对一个或多个原子资源的访问请求。
 */
export type SafetyResource =
  | { kind: 'path'; access: 'read' | 'write'; normalizedPath: string }
  | { kind: 'command-prefix'; prefix: string };
