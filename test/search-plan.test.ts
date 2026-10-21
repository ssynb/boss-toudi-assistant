import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSearchPlan } from '../src/search-plan.ts';
import { MAX_SEARCH_PAGE, validateSearchQuery } from '../src/boss.ts';

const requirements = '北京前端，月薪20K以上';
const plan = { keywords: ['前端'], city: '北京', salaryMinK: 20, maxTargets: 10, excludeCompanies: [], quotes: { direction: '前端', city: '北京', salary: '月薪20K以上' } };

test('缺关键原文依据或搜索参数越界时不接受 AI 计划', () => {
  for (const patch of [
    { quotes: { ...plan.quotes, salary: '' } },
    { quotes: { ...plan.quotes, city: '用户没有说的城市' } },
    { city: '不存在的城市' }, { keywords: [] }, { salaryMinK: -1 }, { maxTargets: 151 },
  ]) assert.throws(() => readSearchPlan({ ...plan, ...patch }, requirements));
  assert.deepEqual(readSearchPlan(plan, requirements), plan);
});

test('浏览器查询仍拒绝非法城市、页码或过长关键词', () => {
  for (const patch of [{ city: '__proto__' }, { page: 0 }, { page: MAX_SEARCH_PAGE + 1 }, { keyword: 'x'.repeat(81) }]) {
    assert.throws(() => validateSearchQuery({ keyword: '前端', city: '北京', page: 1, ...patch }));
  }
  assert.doesNotThrow(() => validateSearchQuery({ keyword: '前端', city: '北京', page: 1 }));
});

test('一轮最多可计划 150 个目标', () => {
  assert.equal(readSearchPlan({ ...plan, maxTargets: 150 }, requirements).maxTargets, 150);
});
