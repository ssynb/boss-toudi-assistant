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


for (const kind of ['猎头', '中介', '外包']) test(`继续时规范限制优先于旧正文：${kind}`, () => {
  const previous = preserveExclusions({ ...plan, criteria: `Python，排除${kind}` }, [`排除${kind}`, `允许${kind}`]);
  const expected = `用户明确限制（优先于下文）：不再排除${kind}。Python，排除${kind}`;
  assert.equal(previous.criteria, expected);
  assert.equal(preserveExclusions(previous, [previous.criteria, '继续']).criteria, expected);
  const changed = preserveExclusions(previous, [previous.criteria, `这次不要${kind}`]);
  assert.equal(changed.criteria, `用户明确限制（优先于下文）：排除${kind}。Python，排除${kind}`, '最新明确修改仍能覆盖最近计划');
});
