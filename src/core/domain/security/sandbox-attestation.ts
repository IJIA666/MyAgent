/**
 * @file Sandbox 状态证明。
 * 报告 platform/backend、文件、网络、进程、凭据和 contained/policy-only/degraded。
 * grant 绑定 attestation version。
 */

/** 沙箱状态等级。 */
export type SandboxLevel = 'contained' | 'policy-only' | 'degraded';

/** Sandbox 运行态证明。 */
export interface SandboxAttestation {
  readonly platform: string;
  readonly backend: string;
  readonly fileIsolation: boolean;
  readonly networkIsolation: boolean;
  readonly processIsolation: boolean;
  readonly credentialIsolation: boolean;
  readonly level: SandboxLevel;
  readonly version: string;
}

/** 由受信组合根提供的 sandbox 探测结果。 */
export interface SandboxAttestationOptions {
  /** 实际 backend 名称。 */
  readonly backend?: string;
  /** 文件隔离是否已成功建立。 */
  readonly fileIsolation?: boolean;
  /** 网络隔离是否已成功建立。 */
  readonly networkIsolation?: boolean;
  /** 进程隔离是否已成功建立。 */
  readonly processIsolation?: boolean;
  /** 凭据隔离是否已成功建立。 */
  readonly credentialIsolation?: boolean;
  /** backend 初始化是否失败；失败时必须报告 degraded。 */
  readonly initializationFailed?: boolean;
}

/** Sandbox attestation 查询端口。 */
export interface SandboxAttestationProvider {
  /**
   * 获取当前执行边界的真实证明。
   *
   * @returns 当前 sandbox attestation
   */
  getAttestation(): SandboxAttestation;
}

/**
 * 为当前平台创建诚实的 sandbox attestation。
 * 原生 Windows 当前无完整 OS containment，默认 policy-only。
 *
 * @returns SandboxAttestation
 */
export function createSandboxAttestation(
  options: SandboxAttestationOptions = {},
): SandboxAttestation {
  const platform = process.platform;
  const fileIsolation = options.fileIsolation ?? false;
  const networkIsolation = options.networkIsolation ?? false;
  const processIsolation = options.processIsolation ?? false;
  const credentialIsolation = options.credentialIsolation ?? false;
  const allIsolationEstablished = fileIsolation
    && networkIsolation
    && processIsolation
    && credentialIsolation;
  return {
    platform,
    backend: options.backend ?? 'native',
    fileIsolation,
    networkIsolation,
    processIsolation,
    // 原生进程仍可继承宿主环境；部分 MCP 适配器的凭据裁剪不能冒充全局隔离。
    credentialIsolation,
    level: options.initializationFailed
      ? 'degraded'
      : allIsolationEstablished
        ? 'contained'
        : 'policy-only',
    version: '1.0.0',
  };
}

/**
 * 原生运行时 attestation provider。
 * 默认诚实报告应用层 policy-only，不把适配器裁剪冒充 OS containment。
 */
export class NativeSandboxAttestationProvider implements SandboxAttestationProvider {
  /** @inheritdoc */
  getAttestation(): SandboxAttestation {
    return createSandboxAttestation();
  }
}
