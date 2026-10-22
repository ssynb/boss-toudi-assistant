import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSearchPlan } from '../src/search-plan.ts';

for (const [message, salaryMinK, criteria] of [
  ['深圳Python，薪资不限，先存草稿', null, 'Python，月薪上限到20K'],
  ['深圳Python，月薪上限到20K，先存草稿', 20, 'Python，薪资不限'],
] as const) test(`模型criteria不能与结构化薪资口径冲突：${salaryMinK}`, () => {
  assert.throws(() => readSearchPlan({ city: '深圳', salaryMinK, criteria, sendNow: false, quote: message, directions: [{ name: 'Python', keywords: ['Python'], count: 1 }] }, message, 0), /criteria|薪资|阈值/);
});


for (const salaryMinK of [0, 30]) test(`字段必须与用户及criteria的20K阈值一致：${salaryMinK}`, () => {
  const message = '深圳Python，月薪上限到20K就行';
  const request = { city: '深圳', salaryMinK, criteria: message, sendNow: false, quote: message, directions: [{ name: 'Python', keywords: ['Python'], count: 1 }] };
  assert.throws(() => readSearchPlan(request, message, 0), /阈值|薪资/);
  assert.doesNotThrow(() => readSearchPlan({ ...request, salaryMinK: 20 }, message, 0));
});

for (const salary of ['月薪上限到20K', '月薪20千', '月薪2万元/月', '工资20000元/月', '月薪1.13万元/月']) test(`比较明确金额时统一为K/月：${salary}`, () => {
  const expected = salary.includes('1.13') ? 11.3 : 20;
  const message = `深圳Python，${salary}，开始`;
  const request = { city: '深圳', salaryMinK: expected, criteria: salary, sendNow: false, quote: message, directions: [{ name: 'Python', keywords: ['Python'], count: 1 }] };
  assert.doesNotThrow(() => readSearchPlan(request, message, 0));
  assert.throws(() => readSearchPlan({ ...request, salaryMinK: 30 }, message, 0), /阈值|薪资/);
  assert.throws(() => readSearchPlan({ ...request, criteria: '月薪30K' }, message, 0), /criteria|阈值|薪资/);
});

test('继续时必须符合历史金额；用户最新明确改成30K时不能继续用20K', () => {
  const request = { city: '深圳', salaryMinK: 30, criteria: 'Python', sendNow: false, quote: '继续', directions: [{ name: 'Python', keywords: ['Python'], count: 1 }] };
  assert.throws(() => readSearchPlan(request, '继续', 0, ['月薪20K']), /阈值|薪资/);
  const message = '改为月薪上限30K，继续';
  assert.doesNotThrow(() => readSearchPlan({ ...request, quote: message }, message, 0, ['月薪20K']));
  assert.throws(() => readSearchPlan({ ...request, salaryMinK: 20, quote: message }, message, 0, ['月薪20K']), /阈值|薪资/);
});
