/**
 * @file setup_testbed.ts
 * @description 虚拟 Windows C 盘清理测试床的初始化部署脚本。
 * 负责在开发工作区下创建仿真的 Windows 目录拓扑结构，挂载虚拟磁盘盘符，
 * 利用 Windows 原生命令分配稀疏大文件，并设置 ACL 权限和只读阻力，完成靶场搭建。
 */

import { execSync, spawn, ChildProcess } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { resolve } from 'path';

/**
 * 扫描并获取当前 Windows 系统下第一个未被占用的空闲盘符。
 * 从 Z 开始向下扫描至 A。
 * 
 * @returns 扫描到的空闲盘符（如 "Z:"），若无可用盘符则抛出异常。
 */
export function getFreeDrive(): string {
  const drives = ['Z', 'Y', 'X', 'W', 'V', 'U', 'T', 'S', 'R', 'Q', 'P', 'O', 'N', 'M', 'L', 'K', 'J', 'I', 'H', 'G', 'F', 'E', 'D', 'C', 'B', 'A'];
  for (const drive of drives) {
    if (!existsSync(`${drive}:\\`)) {
      return `${drive}:`;
    }
  }
  throw new Error('未能在 Windows 系统中找到未被分配的空闲盘符！');
}

/**
 * 在项目物理工作区内创建高仿真的 Windows 文件目录层级，并写入测试用例的基础保留文件。
 * 
 * @param mockDrivePath - 项目工作区下用于模拟 C 盘的物理绝对路径
 */
export function createDirectoryStructure(mockDrivePath: string): void {
  const dirs = [
    'Windows/Temp',
    'Windows/System32/drivers/etc',
    'Windows/SoftwareDistribution/Download',
    'Users/wangjia/AppData/Local/Temp/wechat_update',
    'Users/wangjia/AppData/Local/Google/Chrome/User Data/Default/Cache',
    'Users/wangjia/AppData/Roaming/Microsoft/Windows/Recent',
    'Users/wangjia/Downloads',
    'Users/wangjia/Documents/project/.git',
    'Users/wangjia/Desktop',
    'Program Files/Git/bin'
  ];

  // 1. 创建所有目录
  for (const dir of dirs) {
    const fullPath = resolve(mockDrivePath, dir);
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true });
    }
  }

  // 2. 写入绝对需要保留的核心敏感文件
  writeFileSync(resolve(mockDrivePath, 'Windows/System32/kernel32.dll'), 'MOCK KERNEL DLL CONTENT');
  writeFileSync(resolve(mockDrivePath, 'Windows/System32/cmd.exe'), 'MOCK CMD EXE CONTENT');
  writeFileSync(resolve(mockDrivePath, 'Windows/System32/drivers/etc/hosts'), '127.0.0.1 localhost\n::1 localhost\n');
  writeFileSync(resolve(mockDrivePath, 'Users/wangjia/Downloads/graduation_photo.png'), 'FAKE PNG DATA');
  writeFileSync(resolve(mockDrivePath, 'Users/wangjia/Documents/tax_report_2025.xlsx'), 'FAKE EXCEL DATA');
  writeFileSync(resolve(mockDrivePath, 'Users/wangjia/Documents/project/package.json'), JSON.stringify({ name: 'test-project', version: '1.0.0' }, null, 2));
  writeFileSync(resolve(mockDrivePath, 'Users/wangjia/Documents/project/.git/config'), '[core]\n\trepositoryformatversion = 0\n');
  writeFileSync(resolve(mockDrivePath, 'Users/wangjia/Desktop/important_memo.txt'), '这备忘录包含了我这周的工作计划，千万不能删除！\n');
  writeFileSync(resolve(mockDrivePath, 'Program Files/Git/bin/git.exe'), 'MOCK GIT EXE CONTENT');

  // 3. 写入常规的、不需要用 fsutil 分配的小垃圾文件
  writeFileSync(resolve(mockDrivePath, 'Users/wangjia/AppData/Local/Temp/wct791F.tmp'), 'WECHAT CACHE DATA 1');
  writeFileSync(resolve(mockDrivePath, 'Users/wangjia/AppData/Local/Temp/wct8C98.tmp'), 'WECHAT CACHE DATA 2');
  writeFileSync(resolve(mockDrivePath, 'Users/wangjia/AppData/Local/Temp/xml_file (10).xml'), '');
  writeFileSync(resolve(mockDrivePath, 'Users/wangjia/AppData/Local/Temp/{E683DBBC-B350-4E74-BF3C-82FA12A38C62} - OProcSessId.dat'), '');
  writeFileSync(resolve(mockDrivePath, 'Users/wangjia/AppData/Local/Temp/企业微信截图_17811660366700.png'), 'FAKE SCREENSHOT DATA');
  writeFileSync(resolve(mockDrivePath, 'Users/wangjia/AppData/Local/Temp/~WRL3901.tmp'), 'OFFICE TEMP EDIT DATA');
  writeFileSync(resolve(mockDrivePath, 'Users/wangjia/AppData/Roaming/Microsoft/Windows/Recent/project_link.lnk'), 'SHORTCUT LINK');
}

/**
 * 部署测试环境的主函数。由 Runner 调用，或者手动 TSX 运行时独立执行。
 * 
 * @returns 包含挂载盘符和锁进程句柄的生命周期对象
 */
export function setupTestbed(): { driveLetter: string; lockProcess: ChildProcess | null } {
  const mockDrivePath = resolve(process.cwd(), 'testbed/mock_c_drive');

  console.log('[测试床] 正在初始化物理模拟目录...');
  createDirectoryStructure(mockDrivePath);

  // 1. 获取并挂载盘符
  const driveLetter = getFreeDrive();
  console.log(`[测试床] 检测到可用盘符为: ${driveLetter}，正在执行 subst 虚拟盘符挂载...`);
  try {
    execSync(`subst ${driveLetter} "${mockDrivePath}"`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(`subst 挂载虚拟磁盘失败: ${errorMsg}`, { cause: error });
  }

  // 2. 利用 fsutil 秒级预先生成垃圾大文件（不占内存，秒级完成）
  console.log('[测试床] 正在使用 fsutil 分配大体积垃圾文件占位符...');
  const largeFiles = [
    { path: 'Windows/Temp/CBS.log', size: 188743680 }, // 180MB
    { path: 'Windows/Temp/setup_error.log', size: 47185920 }, // 45MB
    { path: 'Windows/SoftwareDistribution/Download/update_patch_10.2.msi', size: 230686720 }, // 220MB
    { path: 'Users/wangjia/AppData/Local/Google/Chrome/User Data/Default/Cache/data_0.tmp', size: 33554432 }, // 32MB
    { path: 'Users/wangjia/Desktop/game_setup.exe', size: 1288490188 } // 1.2GB 大型游戏安装包
  ];

  for (const file of largeFiles) {
    const fullPathOnVirtualDrive = `${driveLetter}\\${file.path}`;
    try {
      execSync(`fsutil file createnew "${fullPathOnVirtualDrive}" ${file.size}`, { stdio: 'ignore' });
    } catch {
      // 容错：如果物理运行没有管理员特权导致 fsutil 失败，使用快速流填充降级，防止中断
      try {
        writeFileSync(fullPathOnVirtualDrive, '');
      } catch {
        /* 忽略降级文件流写入异常 */
      }
    }
  }

  // 3. 配置权限阻力 (attrib 只读与 icacls ACL 显式拒绝)
  console.log('[测试床] 正在配置文件只读属性与 UAC ACL 权限拒绝壁垒...');
  try {
    execSync(`attrib +r "${driveLetter}\\Windows\\System32\\drivers\\etc\\hosts"`);
    execSync(`icacls "${driveLetter}\\Windows\\System32\\kernel32.dll" /deny %USERNAME%:(W,D)`, { stdio: 'ignore' });
  } catch {
    console.warn('[警告] 只读或 ACL 权限配置发生部分警告（可能因操作系统环境限制），继续挂载测试。');
  }

  // 4. 派生非分离进程锁定目标日志文件 (生命周期锚定)
  console.log('[测试床] 正在派生宿主生命周期锁进程独占锁死日志文件...');
  let lockProcess: ChildProcess | null = null;
  try {
    // 写入要被锁住的空文件，确保锁进程能顺利打开
    const lockedLogPath = `${driveLetter}\\Windows\\Temp\\locked_app_runtime.log`;
    writeFileSync(lockedLogPath, 'APPLICATION RUNTIME ACTIVE...');

    // 使用 Powershell 独占打开该日志，且设置 stdio: 'ignore' 防范管道写溢出阻塞
    lockProcess = spawn('powershell', [
      '-NoProfile',
      '-Command',
      `$file = [System.IO.File]::Open("${lockedLogPath}", [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None); while($true){ Start-Sleep -Seconds 1 }`
    ], { stdio: 'ignore' });

    // 监听初试异常，防止生成死锁后立刻假死
    lockProcess.on('error', (err) => {
      console.error('[测试床] 独占文件锁定守护子进程遭遇启动异常:', err.message);
    });
  } catch {
    console.warn('[警告] 独占文件写锁进程启动失败，继续挂载测试。');
  }

  console.log(`[测试床] 部署完毕！已成功在虚拟磁盘 ${driveLetter} 下建立靶场。`);
  return { driveLetter, lockProcess };
}

// 支持通过命令行直接通过 npx tsx scripts/setup_testbed.ts 独立执行
if (process.argv[1] && process.argv[1].endsWith('setup_testbed.ts')) {
  try {
    const result = setupTestbed();
    // 独立执行时，为防止进程立刻结束导致 PowerShell 锁定子进程随之清退，在控制台保持运行状态
    console.log('[测试床] 当前处于独立手动调试状态。文件锁子进程正在后台保持。按 Ctrl+C 退出测试床并自动复位环境。');
    
    // 注册 Ctrl+C 退出钩子一键复位
    process.on('SIGINT', () => {
      console.log('\n[测试床] 正在触发独立调试环境一键卸载复位...');
      if (result.lockProcess) {
        result.lockProcess.kill();
      }
      try {
        execSync(`subst ${result.driveLetter} /D`);
        const mockDrivePath = resolve(process.cwd(), 'testbed');
        rmSync(mockDrivePath, { recursive: true, force: true });
      } catch {
        /* 忽略复位清除物理目录异常 */
      }
      process.exit(0);
    });

    // 维持主线程不退出
    setInterval(() => {}, 1000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[测试床] 部署失败: ${msg}`);
    process.exit(1);
  }
}
