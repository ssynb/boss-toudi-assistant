import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers.ts';
import { openState } from '../src/state.ts';
import { Executor, type WriteSite } from '../src/executor.ts';

for (const boundary of ['openJob', 'readChat'] as const) {
  test(`暂停发生在 ${boundary} 期间时，不再开始下一次对外动作`, async () => {
    const state = openState(path.join(tempDir('boss-pause-'), 'state.sqlite'));
    const b = state.replaceBatch([{ jobId: 'x', title: '岗位', company: '公司', salary: '', url: 'https://www.zhipin.com/job_detail/x.html', greeting: '你好', reason: '匹配' }]);
    state.approve(b.version);
    const writes: string[] = [];
    let runner: Executor;
    const site: WriteSite = {
      async openJob() { if (boundary === 'openJob') runner.pause(); return { kind: 'canContact', evidence: '' }; },
      async contact() { writes.push('contact'); return { ok: true, evidence: '' }; },
      async readChat() { if (boundary === 'readChat') runner.pause(); return { ourMessages: 0, evidence: '' }; },
      async sendGreeting() { writes.push('greeting'); return { ok: true, evidence: '' }; },
      async sendResume() { writes.push('resume'); return { kind: 'sent', evidence: '' }; },
    };
    runner = new Executor(state, site);
    await runner.start();
    assert.deepEqual(writes, boundary === 'openJob' ? [] : ['contact']);
    assert.equal(state.snapshot().batch?.status, 'paused');
    state.close();
  });
}
