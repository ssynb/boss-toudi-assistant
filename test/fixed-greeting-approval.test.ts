import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openState } from '../src/state.ts';

test('清空固定招呼后，旧草稿不能被重新批准为空文本发送', () => {
  const state = openState(':memory:');
  try {
    state.saveInputs({ greeting: '您好', requirements: '', resume: { text: '简历' } });
    const batch = state.replaceBatch([{ jobId: 'a', company: '公司', title: '岗位', salary: '', url: 'https://www.zhipin.com/job_detail/a.html', reason: '匹配', greeting: '您好' }]);
    state.approve(batch.version);
    state.saveInputs({ greeting: '', requirements: '', resume: { text: null } });
    const current = state.snapshot().batch!;
    assert.equal(current.targets[0]!.greeting, '');
    assert.throws(() => state.approve(current.version), { code: 'not_approvable' });
    assert.equal(state.snapshot().batch!.status, 'draft');
  } finally { state.close(); }
});
