/**
 * @file `/sandbox` 命令实现。
 * 展示当前 platform、backend、文件/网络/进程/credential 边界与 contained/policy-only/degraded。
 */

import type { ICommand, CommandContext } from './base.js';
import { theme } from '../views/theme.js';
import { createSandboxAttestation } from '../../../../core/domain/security/sandbox-attestation.js';

export class SandboxCommand implements ICommand {
  name = 'sandbox';
  description = '查看当前沙箱隔离状态';

  async execute(_args: string[], _context: CommandContext): Promise<void> {
    const attestation = createSandboxAttestation();

    console.log();
    console.log(theme.highlight('╌ Sandbox 状态 ╌'));
    console.log(`  平台: ${attestation.platform}`);
    console.log(`  后端: ${attestation.backend}`);
    console.log(`  等级: ${formatLevel(attestation.level)}`);

    console.log();
    console.log(theme.highlight('╌ 隔离边界 ╌'));
    console.log(`  文件隔离:     ${formatBool(attestation.fileIsolation)}`);
    console.log(`  网络隔离:     ${formatBool(attestation.networkIsolation)}`);
    console.log(`  进程隔离:     ${formatBool(attestation.processIsolation)}`);
    console.log(`  凭据隔离:     ${formatBool(attestation.credentialIsolation)}`);

    if (attestation.level === 'policy-only') {
      console.log();
      console.log(theme.dim('当前仅有应用层权限策略，无 OS 级沙箱。高风险操作请谨慎批准。'));
    }
  }
}

function formatLevel(level: string): string {
  switch (level) {
    case 'contained': return theme.success('✔ contained');
    case 'policy-only': return theme.warning('● policy-only');
    case 'degraded': return theme.error('✘ degraded');
    default: return level;
  }
}

function formatBool(value: boolean): string {
  return value ? theme.success('有') : theme.dim('无');
}
