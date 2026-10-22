import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSearchPlan } from '../src/search-plan.ts';

for (const message of ['薪资不限，公司融资超过1000万元，开始', '继续']) test(`公司金额不是工资条件：${message}`, () => {
  const plan = { city: '深圳', salaryMinK: null, criteria: 'Python，公司融资超过1000万元', quote: message, sendNow: false, directions: [{ name: 'Python', keywords: ['Python'], count: 1 }] };
  assert.doesNotThrow(() => readSearchPlan(plan, message, 0, ['薪资不限']));
});
