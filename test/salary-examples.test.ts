import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSearchPlan } from '../src/search-plan.ts';

for (const message of ['深圳Python，月薪上限20K，例如15-25K也满足', '深圳Python，月薪20K，相当于年薪24万']) {
  test(`补充薪资说明不能覆盖或抹掉明确的20K月薪阈值：${message}`, () => {
    const request = { city: '深圳', salaryMinK: 20, criteria: message, quote: message, sendNow: false, directions: [{ name: 'Python', keywords: ['Python'], count: 1 }] };
    assert.doesNotThrow(() => readSearchPlan(request, message, 0));
    assert.throws(() => readSearchPlan({ ...request, salaryMinK: 30 }, message, 0), /阈值|薪资/);
  });
}
