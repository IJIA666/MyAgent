/**
 * @file SkillUsageStore 跨进程并发测试子进程入口。
 * 对同一 Skill 连续记录查看次数，供父测试验证锁内读改写不会丢更新。
 */

import { SkillUsageStore } from '../../src/core/usecases/brain/skill-usage-store.js';

const [, , usagePath, skillName, rawIterations] = process.argv;
if (!usagePath || !skillName || !rawIterations) {
  throw new Error('usagePath、skillName 和 iterations 均为必填参数');
}

const iterations = Number.parseInt(rawIterations, 10);
if (!Number.isInteger(iterations) || iterations <= 0) {
  throw new Error('iterations 必须是正整数');
}

const store = new SkillUsageStore(usagePath);
for (let index = 0; index < iterations; index++) {
  await store.recordView(skillName);
}
