import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rejectCard, type SearchPlan } from '../src/search-plan.ts';

// 2026-11-10 真实卡片：标题写明「…-联想外包岗位-深圳」却没有标识图标，旧预筛只看图标，打开JD后才拒绝。
const plan = (criteria: string): SearchPlan => ({ city: '深圳', salaryMinK: 20, criteria, sendNow: false, quote: '', directions: [] });
const card = (title: string) => ({ title, company: '北京四方小仓', salary: '15-30K' });

test('排除外包时，标题明确写外包岗位的卡片不打开详情；「非外包岗位」与未排除外包时不拦', () => {
  const excluded = plan('用户明确限制（优先于下文）：排除外包。Python');
  assert.deepEqual(rejectCard(card('AI应用开发工程师-联想外包岗位-深圳'), excluded), { category: '外包/猎头/中介', rule: '卡片标识', evidence: 'AI应用开发工程师-联想外包岗位-深圳' });
  assert.equal(rejectCard(card('Python开发（外包岗）'), excluded)?.rule, '卡片标识');
  assert.equal(rejectCard(card('Python开发（非外包岗位）'), excluded), null);
  assert.equal(rejectCard(card('Python开发，不是外包岗位'), excluded), null);
  assert.equal(rejectCard(card('AI应用开发工程师-联想外包岗位-深圳'), plan('Python')), null);
});
