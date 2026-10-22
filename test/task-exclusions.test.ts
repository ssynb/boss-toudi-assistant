import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preserveExclusions, type SearchPlan } from '../src/search-plan.ts';

const plan: SearchPlan = { city: '深圳', salaryMinK: null, criteria: 'Python', sendNow: true, quote: '继续', directions: [{ name: 'AI开发', keywords: ['Agent'], count: 1 }] };

test('允许外包不能解除同一句里明确的猎头排除', () => {
  const result = preserveExclusions(plan, ['不要猎头、外包', '允许外包，但不要猎头']);
  assert.equal(result.criteria, '用户明确限制（优先于下文）：排除猎头；不再排除外包。Python');
});

test('已保存的解除排除条件在继续任务时不能反转成排除', () => {
  const result = preserveExclusions(plan, ['用户明确限制（优先于下文）：不再排除外包。Python', '继续']);
  assert.equal(result.criteria, '用户明确限制（优先于下文）：不再排除外包。Python');
});
