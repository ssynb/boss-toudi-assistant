import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSearchPlan } from '../src/search-plan.ts';

for (const requirement of ['开始找Python岗位', '月薪希望高一些', '月薪两万', '月薪15-25K', '年薪30万']) {
  test(`没有可核对的单一月薪数值时不能接受任意阈值：${requirement}`, () => {
    for (const salaryMinK of [0, 30]) {
      assert.throws(() => readSearchPlan({ city: '深圳', salaryMinK, criteria: requirement, quote: requirement, sendNow: false, directions: [{ name: 'Python', keywords: ['Python'], count: 1 }] }, requirement, 0), /薪资|阈值|澄清/);
    }
  });
}
