import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openState } from '../src/state.ts';
import { Executor, type WriteSite } from '../src/executor.ts';
import { tempDir } from './helpers.ts';

for (const previousUnknown of [false, true]) {
  test(`已有空会话不重复联系；历史未知记录仍不可重试=${previousUnknown}`, async () => {
    const state = openState(path.join(tempDir('boss-existing-'), 'state.sqlite'));
    const draft = { jobId: 'job', company: '公司', title: '岗位', salary: '', url: 'https://www.zhipin.com/job_detail/job.html', reason: '匹配', greeting: '已批准招呼' };
    const identity = { kind: 'chatId' as const, jobId: 'job', recruiterId: 'recruiter' };
    const calls: string[] = [];
    try {
      if (previousUnknown) {
        const old = state.replaceBatch([draft]);
        state.setStep(old.targets[0]!, 'contact', 'unknown', '历史联系结果不明');
      }
      const batch = state.replaceBatch([draft]);
      state.approve(batch.version);
      const site: WriteSite = {
        openJob: async () => { calls.push('read-existing'); return { kind: 'existingConversation', identity, evidence: '完整历史没有本方消息' }; },
        contact: async () => { calls.push('contact'); throw new Error('已有会话不得再点联系'); },
        readChat: async () => { calls.push('read-messages'); return { ourMessages: 0, evidence: '完整历史没有本方消息' }; },
        sendGreeting: async (_t, text) => { calls.push(text); return { ok: true, evidence: '合成消息已出现' }; },
      };
      await new Executor(state, site).start();
      const result = state.snapshot().batch!;
      assert.deepEqual(calls, previousUnknown ? [] : ['read-existing', 'read-messages', '已批准招呼']);
      assert.equal(result.status, 'done');
      assert.deepEqual(result.targets[0]!.steps, previousUnknown ? { contact: 'skipped', greeting: 'skipped' } : { contact: 'done', greeting: 'done' });
      if (!previousUnknown) assert.deepEqual(result.targets[0]!.contactIdentity, identity);
      assert.equal(state.snapshot().contactedCount, 1);
    } finally { state.close(); }
  });
}
