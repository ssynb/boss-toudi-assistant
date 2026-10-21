import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBossSite } from '../src/boss.ts';
import type { Target } from '../src/contracts.ts';
import { bossBrowser, draft, localBrowser, startBoss, TARGET } from './boss-fixture.ts';

const preceding = Array.from({ length: 48 }, (_, i) => ({ ...TARGET, jobId: `job-${i}`, bossId: `boss-${i}`, friendId: 100+i }));
const target = { ...draft(), contactIdentity: { kind: 'chatId', jobId: TARGET.jobId, recruiterId: TARGET.bossId } } as Target;
for (const mode of ['exact', 'other-job', 'duplicate', 'incomplete'] as const) {
  test(`虚拟会话列表按完整数据确认身份：${mode}`, async () => {
    const tail = mode === 'other-job' ? { ...TARGET, jobId: 'other-job' } : TARGET;
    const f = await startBoss({ continued: true, windowSize: 4, hasMoreFriends: mode === 'incomplete',
      friends: mode === 'incomplete' ? [TARGET, ...preceding] : [...(mode === 'duplicate' ? [TARGET] : []), ...preceding, tail] });
    const browser = localBrowser('virtual-chat');
    const site = createBossSite(bossBrowser(browser, f));
    try {
      const opened = await site.openJob(target);
      assert.equal(opened.kind, mode === 'exact' ? 'existingConversation' : mode === 'other-job' ? 'alreadyContacted' : 'blocked', opened.evidence);
      if (mode === 'exact') {
        assert.equal((await site.readChat(target)).ourMessages, 0);
        assert.equal(await browser.eval(`document.querySelector('.chat-conversation').__vue__.selectedFriend$.encryptJobId`), TARGET.jobId);
      } else if (mode === 'other-job') assert.match(opened.evidence, /其他岗位/);
      else assert.deepEqual(f.historyRequests, [], '不完整或不唯一的数据不得选中会话');
      assert.deepEqual([f.contacts, f.sends], [0, []]);
    } finally { await site.close(); await f.close(); }
  });
}
