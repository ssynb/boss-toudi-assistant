import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSearchPlan } from '../src/search-plan.ts';

const latest = '深圳Python3个，薪资不限，开始';
const base = { city: '深圳', salaryMinK: null, criteria: 'Python', sendNow: false, quote: '开始', excludedCompanies: [], degreeLimit: null, directions: [{ name: 'Python', keywords: ['Python'], count: 3 }] };
const read = (requirements: string) => readSearchPlan({ ...base }, latest, 0, ['薪资不限'], [requirements]);

test('推荐来源与推荐耗尽后搜索补充只认独立配置行，句中提及或否定不生效', () => {
  const pinned = read('推荐来源：Python(深圳)\n推荐耗尽后搜索补充：允许');
  assert.deepEqual([pinned.recommendationTab, pinned.searchAfterExhausted], ['Python(深圳)', true]);
  for (const text of ['推荐来源：Python(深圳)\n不要设置推荐耗尽后搜索补充：允许', '推荐来源：Python(深圳)\n推荐耗尽后搜索补充：不允许', '推荐来源：Python(深圳)']) {
    assert.equal(read(text).searchAfterExhausted, false, text);
  }
  assert.equal(read('别再用推荐来源：Python(深圳)').recommendationTab, undefined);
});
