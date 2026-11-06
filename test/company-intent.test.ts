import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardPolicy, readSearchPlan, rejectCard } from '../src/search-plan.ts';

const base = { city: '深圳', salaryMinK: null, criteria: '后端', sendNow: false, quote: '开始', degreeLimit: null, directions: [{ name: '后端', keywords: ['后端'], count: 1 }] };
const accepts = (text: string, excludedCompanies: string[]) => readSearchPlan({ ...base, excludedCompanies }, '深圳后端1个，薪资不限，开始', 0, ['薪资不限'], [text]);
const rejected = (plan: ReturnType<typeof accepts>, company: string) => rejectCard({ company, salary: '20-30K' }, plan)?.rule ?? null;

// 第4轮审查：任务意图按「不投」前的动作识别，时间限定词不吞掉其后的品牌，品牌内部的字（先声药业）不当作任务词。
for (const [text, companies, blocked, allowed] of [
  ['今天软通动力不投', ['软通动力'], '软通动力信息', '软通智慧'],
  ['这次外企德科不投', ['外企德科'], '外企德科数字', '德科智能'],
  ['先声药业不投', ['先声药业'], '先声药业集团', '先导智能'],
  ['软通动力不投', ['软通动力'], '软通动力信息', '软通智慧'],
  ['今天只找不投', [], null, '今天科技'],
  ['先存草稿不投', [], null, '草稿科技'],
  ['暂时不投', [], null, '暂时科技'],
] as const) test(`任务意图与前置公司名单：${text}`, () => {
  assert.deepEqual(cardPolicy([text]).companies, companies);
  const plan = accepts(text, [...companies]);
  if (blocked) assert.equal(rejected(plan, blocked), '公司黑名单');
  assert.equal(rejected(plan, allowed), null);
  if (companies.length) assert.throws(() => accepts(text, []), /excludedCompanies/, '明确名单不能以空策略通过');
});

test('去掉时间限定后只剩通用词时要求澄清，不生成过宽的限制', () => {
  for (const text of ['今天国际不投', '软件不投']) assert.throws(() => cardPolicy([text]), /澄清/, text);
});
