import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSearchPlan } from '../src/search-plan.ts';
import { MAX_SEARCH_PAGE, validateSearchQuery } from '../src/boss.ts';

const requirements = '北京前端，月薪20K以上，找10个只存草稿';
const plan = { city: '北京', salaryMinK: 20, criteria: '前端，20K以上', sendNow: false, quote: requirements, directions: [{ name: '前端', keywords: ['前端'], count: 10 }] };

test('新任务必须引用最新消息原文，参数或今日额度越界时不接受', () => {
  for (const patch of [
    { quote: '' }, { quote: '之前一轮说过的内容' }, { city: '不存在的城市' }, { salaryMinK: -1 },
    { directions: [] }, { directions: [{ ...plan.directions[0], count: 151 }] },
    { directions: [{ ...plan.directions[0], keywords: [] }] }, { sendNow: 'true' },
  ]) assert.throws(() => readSearchPlan({ ...plan, ...patch }, requirements, 0));
  assert.throws(() => readSearchPlan(plan, requirements, 145), /5/);
  assert.deepEqual(readSearchPlan(plan, requirements, 0), plan);
});

test('浏览器查询仍拒绝非法城市、页码或过长关键词', () => {
  for (const patch of [{ city: '__proto__' }, { page: 0 }, { page: MAX_SEARCH_PAGE + 1 }, { keyword: 'x'.repeat(81) }]) {
    assert.throws(() => validateSearchQuery({ keyword: '前端', city: '北京', page: 1, ...patch }));
  }
  assert.doesNotThrow(() => validateSearchQuery({ keyword: '前端', city: '北京', page: 1 }));
});

test('一轮最多可计划 150 个目标', () => {
  assert.equal(readSearchPlan({ ...plan, directions: [{ ...plan.directions[0], count: 150 }] }, requirements, 0).directions[0]!.count, 150);
});

for (const requirement of ['月薪上限到20K就行', '工资至少20000元/月', '月薪希望高一些', '开始找前端岗位']) {
  test(`没有明确不限时不能将salaryMinK置空：${requirement}`, () => {
    assert.throws(() => readSearchPlan({ ...plan, salaryMinK: null, quote: requirement, criteria: requirement }, requirement, 0), /salaryMinK|薪资|阈值/);
  });
}

test('薪资语义沿用历史且最新明确修改优先，null只表示明确不限', () => {
  const request = { ...plan, salaryMinK: null, criteria: '前端', quote: '继续' };
  assert.throws(() => readSearchPlan(request, '继续', 0, ['薪资不限', '月薪上限到20K就行']), /salaryMinK|阈值/);
  assert.doesNotThrow(() => readSearchPlan(request, '继续', 0, ['月薪上限到20K就行', '薪资不限']));
  assert.doesNotThrow(() => readSearchPlan({ ...request, quote: '薪资不限，开始' }, '薪资不限，开始', 0, ['月薪20K']));
});
