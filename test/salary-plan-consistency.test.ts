import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSearchPlan } from '../src/search-plan.ts';

for (const [message, salaryMinK, criteria] of [
  ['深圳Python，薪资不限，先存草稿', null, 'Python，月薪上限到20K'],
  ['深圳Python，月薪上限到20K，先存草稿', 20, 'Python，薪资不限'],
] as const) test(`模型criteria不能与结构化薪资口径冲突：${salaryMinK}`, () => {
  assert.throws(() => readSearchPlan({ city: '深圳', salaryMinK, criteria, sendNow: false, quote: message, directions: [{ name: 'Python', keywords: ['Python'], count: 1 }] }, message, 0), /criteria|薪资|阈值/);
});
