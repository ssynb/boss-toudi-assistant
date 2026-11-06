import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardPolicy, readSearchPlan, rejectCard } from '../src/search-plan.ts';

const latest = '深圳后端10个，薪资不限，开始';
const base = { city: '深圳', salaryMinK: null, criteria: '后端', sendNow: false, quote: '开始', degreeLimit: null, directions: [{ name: '后端', keywords: ['后端'], count: 10 }] };
const accepts = (text: string, excludedCompanies: string[]) => readSearchPlan({ ...base, excludedCompanies }, latest, 0, ['薪资不限'], [text]);
const card = (company: string) => ({ company, salary: '20-30K' });

// 第2轮审查反例与上一轮已修表达同一回归集：解析、计划接收与卡片预筛一起核对。
for (const [text, expected, blocked, allowed] of [
  ['不要投软通动力公司', ['软通动力'], '软通动力信息', '软通智慧'],
  ['不投软通动力', ['软通动力'], '软通动力信息', '软通智慧'],
  ['公司黑名单：软通动力', ['软通动力'], '软通动力信息', '软通智慧'],
  ['不投中和软件', ['中和软件'], '中和软件科技', '金蝶软件'],
  ['不投万和公司', ['万和'], '万和电气', '万科'],
  ['今天只找不投', [], null, '今天科技'],
  ['这次只找不投，先存草稿', [], null, '这次科技'],
] as const) test(`公司名单解析：${text}`, () => {
  assert.deepEqual(cardPolicy([text]).companies, expected);
  const plan = accepts(text, [...expected]);
  if (blocked) assert.equal(rejectCard(card(blocked), plan)?.rule, '公司黑名单');
  assert.equal(rejectCard(card(allowed), plan), null, `${allowed} 不能被误伤`);
});

test('连接词既可能是名单分隔也可能是品牌一部分时，接受整名或完整拆分，不接受碎片', () => {
  const text = '屏蔽软通动力和中软国际的岗位';
  assert.doesNotThrow(() => accepts(text, ['软通动力', '中软国际']));
  assert.doesNotThrow(() => accepts(text, ['软通动力和中软国际']));
  assert.throws(() => accepts(text, ['软通动力']), /excludedCompanies/);
  assert.throws(() => accepts('不投中和软件', ['软件']), /excludedCompanies/);
});
