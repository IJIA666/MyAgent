/**
 * @file teardown_testbed.ts
 * @description 虚拟 Windows C 盘清理测试床的销毁与环境复位脚本。
 * 负责强行解绑并终结文件锁定子进程，递归重置 ACL 权限与只读文件属性，
 * 动态检索指向当前工程的 subst 虚拟磁盘盘符并执行卸载，最后彻底物理删除 testbed 测试目录。
 */

import { execSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { resolve } from 'path';

/**
 * 递归扫描并终结持有 locked_app_runtime.log 文件独占锁的后台 PowerShell 僵尸进程。
 */
export function killLockingProcesses(): void {
  try {
    // 扫描系统进程中包含 locked_app_runtime.log 命令参数的 PowerShell 实例并强行终止
    execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \'*locked_app_runtime.log*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"',
      { stdio: 'ignore' }
    );
  } catch {
    // 忽略找不到进程的报错
  }
}

/**
 * 动态查询 subst 列表，找到所有物理路径指向当前项目 testbed/mock_c_drive 的挂载盘符并执行强行卸载。
 * 
 * @param physicalPath - 模拟 C 盘所在的本地物理绝对路径
 */
export function unmountSubstDrives(physicalPath: string): void {
  try {
    const rawSubst = execSync('subst').toString();
    const normalizedPhysical = physicalPath.toLowerCase().replace(/\\/g, '/');

    // subst 的输出格式通常为: Z:\: => D:\Projects\MyAgent\testbed\mock_c_drive
    const lines = rawSubst.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;

      const parts = line.split('=>');
      if (parts.length === 2) {
        const driveLetter = parts[0].trim().substring(0, 2); // 提取如 "Z:"
        const mappedPath = parts[1].trim().toLowerCase().replace(/\\/g, '/');

        // 匹配物理路径，执行卸载
        if (mappedPath === normalizedPhysical || mappedPath.startsWith(normalizedPhysical)) {
          console.log(`[测试床] 发现挂载映射关系: ${driveLetter} => ${parts[1].trim()}，正在执行卸载...`);
          
          // 在卸载前，强行重置 ACL 权限和只读，以防文件锁死
          try {
            execSync(`attrib -r "${driveLetter}\\Windows\\System32\\drivers\\etc\\hosts"`, { stdio: 'ignore' });
            execSync(`icacls "${driveLetter}\\Windows\\System32" /reset /T`, { stdio: 'ignore' });
          } catch {
            /* 忽略权限复位异常 */
          }

          // 卸载 subst 盘符
          execSync(`subst ${driveLetter} /D`);
          console.log(`[测试床] 虚拟盘 ${driveLetter} 已成功卸载。`);
        }
      }
    }
  } catch {
    console.warn('[测试床] 查询或卸载 subst 虚拟盘时遇到警告（可能当前无任何活动挂载）。');
  }
}

/**
 * 环境复位与清理的主函数。由 Runner 退出时自动调用，或者手动 TSX 独立执行。
 */
export function teardownTestbed(): void {
  const mockDrivePath = resolve(process.cwd(), 'testbed/mock_c_drive');

  console.log('[测试床] 开始执行环境销毁与复位清理流程...');

  // 1. 强力清杀持锁后台进程
  console.log('[测试床] 正在清杀可能持锁的后台守护进程...');
  killLockingProcesses();

  // 2. 动态扫描并解除 subst 虚拟盘符挂载
  console.log('[测试床] 正在扫描并解除指向本工程的 subst 盘符映射...');
  unmountSubstDrives(mockDrivePath);

  // 3. 彻底递归销毁工作区物理 testbed 目录
  const testbedPath = resolve(process.cwd(), 'testbed');
  if (existsSync(testbedPath)) {
    // 强行重置物理目录的 ACL 与属性，防范残留权限死锁导致删除失败
    try {
      execSync(`icacls "${testbedPath}" /reset /T`, { stdio: 'ignore' });
      execSync(`attrib -r "${testbedPath}\\*" /S /D`, { stdio: 'ignore' });
    } catch {
      /* 忽略前置物理权限清理异常 */
    }

    console.log('[测试床] 正在递归销毁物理 testbed/ 缓存目录...');
    try {
      rmSync(testbedPath, { recursive: true, force: true });
      console.log('[测试床] 物理测试目录已清空彻底销毁。');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[测试床] 销毁物理目录失败（可能部分文件仍被锁定占有）: ${errorMsg}`);
    }
  }

  console.log('[测试床] 环境复位清理完成。');
}

// 支持通过命令行直接通过 npx tsx test/scripts/teardown_testbed.ts 独立执行
if (process.argv[1] && process.argv[1].endsWith('teardown_testbed.ts')) {
  try {
    teardownTestbed();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[测试床] 复位失败: ${msg}`);
    process.exit(1);
  }
}
