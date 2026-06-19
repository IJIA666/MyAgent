import { ICommand } from './base.js';
import { theme } from '../views/theme.js';
import * as fs from 'fs/promises';
import * as path from 'path';

export class HistoryCommand implements ICommand {
  name = 'history';
  description = '查看保存的历史会话列表';

  async execute(): Promise<void> {
    const dir = path.join(process.cwd(), '.myagent/sessions');
    try {
      const files = await fs.readdir(dir);
      const jsonFiles = files.filter(f => f.endsWith('.json'));
      if (jsonFiles.length === 0) {
        console.log(theme.info('[系统] 暂无任何历史会话记录。'));
        return;
      }

      console.log(`\n${theme.success('历史会话列表:')}`);

      const fileStats = await Promise.all(jsonFiles.map(async file => {
        const stats = await fs.stat(path.join(dir, file));
        return { file, mtime: stats.mtimeMs, mtimeDate: stats.mtime };
      }));

      fileStats.sort((a, b) => b.mtime - a.mtime);

      for (const fsObj of fileStats) {
        const id = fsObj.file.replace('.json', '');
        const dateStr = fsObj.mtimeDate.toLocaleString();
        console.log(`  ${theme.highlight(id)}  -  ${theme.dim(dateStr)}`);
      }
      console.log(`\n使用 ${theme.highlight('/resume <id>')} 恢复指定的会话。\n`);
    } catch {
      console.log(theme.info('[系统] 暂无任何历史会话记录。'));
    }
  }
}
