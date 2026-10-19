import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openState } from '../src/state.ts';
import { Executor, type WriteSite } from '../src/executor.ts';
import { createBossSite } from '../src/boss.ts';
import type { Browser } from '../src/browser.ts';
import { tempDir } from './helpers.ts';

const draft = { jobId: 'A', company: '公司', title: '岗位', salary: '', url: 'https://www.zhipin.com/job_detail/A.html', reason: '', greeting: '你好' };
const identity = { jobId: 'A', recruiterUrl: 'https://www.zhipin.com/boss_detail/hrA.html' };

for (const pending of ['greeting', 'resume'] as const) {
  test(`重启后只读核对已持久化身份，再继续 ${pending}，不重复联系`, async () => {
    const file = path.join(tempDir('boss-restart-'), 'state.sqlite');
    let state = openState(file);
    state.replaceBatch([draft]);
    state.patchBatch({ resumeDelivery: { enabled: true, bossAttachmentName: 'resume.pdf', bossAttachmentConfirmed: true } });
    state.approve(state.snapshot().batch!.version);
    let runner: Executor;
    const writes: string[] = [];
    const first: WriteSite = {
      async openJob() { return { kind: 'canContact', evidence: '' }; },
      async contact() { writes.push('contact'); if (pending === 'greeting') runner.pause(); return { ok: true, evidence: '已核实岗位和招聘者', identity }; },
      async readChat() { return { ourMessages: 0, evidence: '' }; },
      async sendGreeting() { writes.push('greeting'); runner.pause(); return { ok: true, evidence: '' }; },
      async sendResume() { throw new Error('暂停前不应发附件'); },
    };
    runner = new Executor(state, first);
    await runner.start();
    state.close();
    state = openState(file);
    let activeRecruiter = 'hrB';
    const browser = {
      isOpen: true,
      async eval(expression: string) {
        if (expression.includes('hasAccount')) return { url: 'https://www.zhipin.com/web/geek/chat', title: '', hasAccount: true, loginLink: false };
        if (expression.includes('hasHistory')) return { company: '公司', hasHistory: true, job: draft.url, recruiter: `https://www.zhipin.com/boss_detail/${activeRecruiter}.html` };
        if (expression.includes('暂无聊天记录')) return true;
        return [];
      },
    } as unknown as Browser;
    const site = createBossSite(browser);
    const resumed: WriteSite = {
      ...first,
      async openJob() { throw new Error('不能重开联系'); },
      async contact() { throw new Error('不能重复联系'); },
      readChat: (t) => site.readChat(t),
      async sendGreeting(t) { await site.readChat(t); writes.push('greeting'); return { ok: true, evidence: '' }; },
      async sendResume(t) { await site.readChat(t); writes.push('resume'); return { kind: 'sent', evidence: '' }; },
    };
    await new Executor(state, resumed).start().catch(() => {});
    assert.equal(state.snapshot().batch!.status, 'paused');
    assert.equal(state.snapshot().batch!.targets[0]!.steps[pending], 'todo', '身份不符时尚未开始外部动作');
    assert.match(state.snapshot().batch!.stopReason!, /会话|身份|招聘者/);
    activeRecruiter = 'hrA';
    await new Executor(state, resumed).start();
    assert.equal(state.snapshot().batch!.status, 'done');
    assert.deepEqual(writes, ['contact', 'greeting', 'resume']);
    state.close();
  });
}

test('旧账本缺少身份时给出可执行下一步，保留 todo 而非宣告恢复成功', async () => {
  const state = openState(path.join(tempDir('boss-legacy-'), 'state.sqlite'));
  const batch = state.replaceBatch([draft]);
  state.approve(batch.version);
  state.beginRun();
  state.setStep(batch.targets[0]!, 'contact', 'done', '旧记录');
  state.finishRun('paused', null);
  const browser = {
    isOpen: true,
    async eval(expression: string) {
      if (expression.includes('hasAccount')) return { url: 'https://www.zhipin.com/web/geek/chat', hasAccount: true, title: '', loginLink: false };
      return { company: '公司', hasHistory: true, job: draft.url, recruiter: identity.recruiterUrl };
    },
  } as unknown as Browser;
  await new Executor(state, createBossSite(browser)).start().catch(() => {});
  const result = state.snapshot().batch!;
  assert.equal(result.status, 'paused');
  assert.equal(result.targets[0]!.steps.greeting, 'todo');
  assert.match(result.stopReason!, /缺少.*身份.*BOSS.*手动/);
  state.close();
});
