import fs from 'fs';
import path from 'path';

/**
 * 更新 .env 文件中指定键的值。
 * 使用基于正则的非破坏性替换策略，安全保留原有的注释和排版结构。
 * 若键不存在，则在文件末尾追加。
 *
 * @param key 环境变量名（例如 'DEEPSEEK_MODEL'）
 * @param value 新的环境变量值
 */
export function updateEnvVariable(key: string, value: string): void {
  const envPath = path.resolve(process.cwd(), '.env');
  
  let envContent = '';
  try {
    envContent = fs.readFileSync(envPath, 'utf8');
  } catch (err: unknown) {
    // 如果 .env 不存在，则作为一个新文件处理
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code !== 'ENOENT') {
      throw err;
    }
  }

  // 构造匹配以该 key 开头的整行正则，考虑行首的可能空格
  // 匹配形如：DEEPSEEK_MODEL=xxx 的一整行
  const regex = new RegExp(`^\\s*${key}=.*$`, 'm');
  const newRow = `${key}=${value}`;

  if (regex.test(envContent)) {
    // 找到了，替换该行
    envContent = envContent.replace(regex, newRow);
  } else {
    // 没找到，追加到末尾
    // 如果文件非空且最后没有换行符，先加个换行符
    if (envContent.length > 0 && !envContent.endsWith('\n')) {
      envContent += '\n';
    }
    envContent += newRow + '\n';
  }

  fs.writeFileSync(envPath, envContent, 'utf8');
}
