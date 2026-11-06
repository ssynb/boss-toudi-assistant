import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardPolicy, readSearchPlan, rejectCard } from '../src/search-plan.ts';

const base = { city: '深圳', salaryMinK: null, criteria: '后端', sendNow: false, quote: '开始', degreeLimit: null, directions: [{ name: '后端', keywords: ['后端'], count: 1 }] };
const accepts = (text: string, excludedCompanies: string[]) => readSearchPlan({ ...base, excludedCompanies }, '深圳后端1个，薪资不限，开始', 0, ['薪资不限'], [text]);
const rejected = (plan: ReturnType<typeof accepts>, company: string) => rejectCard({ company, salary: '20-30K' }, plan)?.rule ?? null;

// 公司名不剥离时间前缀；无分隔的时间限定表达须澄清。
for (const [text, companies, blocked, allowed] of [
  ['今日头条不投', ['今日头条'], '今日头条', '趣头条'],
  ['不投今日头条', ['今日头条'], '今日头条', '趣头条'],
  ['每日优鲜不投', ['每日优鲜'], '每日优鲜', '优鲜科技'],
  ['屏蔽公司：今天国际', ['今天国际'], '今天国际', '国际科技'],
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

test('无分隔时间限定与通用词要求澄清，不生成碎片限制', () => {
  for (const text of ['今天国际不投', '今天软通动力不投', '这次外企德科不投', '软件不投']) assert.throws(() => cardPolicy([text]), /澄清/, text);
});
