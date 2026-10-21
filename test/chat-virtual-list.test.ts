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
      assert.equal(opened.kind, (mode === 'exact' || mode === 'incomplete') ? 'existingConversation' : mode === 'other-job' ? 'alreadyContacted' : 'blocked', opened.evidence);
      if (mode === 'exact' || mode === 'incomplete') {
        assert.equal((await site.readChat(target)).ourMessages, 0);
        assert.equal(await browser.eval(`document.querySelector('.chat-conversation').__vue__.selectedFriend$.encryptJobId`), TARGET.jobId);
      } else if (mode === 'other-job') assert.match(opened.evidence, /其他岗位/);
      else assert.deepEqual(f.historyRequests, [], '不唯一的数据不得选中会话');
      assert.deepEqual([f.contacts, f.sends], [0, []]);
    } finally { await site.close(); await f.close(); }
  });
}

test('完整列表有目标但滚动到底仍不渲染目标行时明确失败', async () => {
  const f = await startBoss({ continued: true, windowSize: 4, omitTargetRow: true, friends: [...preceding.slice(0, 8), TARGET] });
  const browser = localBrowser('virtual-chat-missing');
  const site = createBossSite(bossBrowser(browser, f));
  try {
    const opened = await site.openJob(target);
    assert.equal(opened.kind, 'blocked');
    assert.match(opened.evidence, /滚动到底|达到上限/);
    assert.deepEqual([f.contacts, f.sends, f.historyRequests], [0, [], []]);
  } finally { await site.close(); await f.close(); }
});

for (const later of ['exact', 'other-job', 'missing'] as const) {
  test(`目标不在首批时加载下一页直到${later}`, async () => {
    const last = later === 'exact' ? [TARGET] : later === 'other-job' ? [{ ...TARGET, jobId: 'other-job' }] : [];
    const f = await startBoss({ continued: true, windowSize: 4, friends: preceding.slice(0, 8), friendPages: [preceding.slice(8,16), last] });
    const browser = localBrowser('chat-friend-pages');
    const site = createBossSite(bossBrowser(browser, f));
    try {
      const opened = await site.openJob(target);
      assert.equal(opened.kind, later === 'exact' ? 'existingConversation' : later === 'other-job' ? 'alreadyContacted' : 'blocked', opened.evidence);
      assert.deepEqual([f.contacts, f.sends], [0, []]);
    } finally { await site.close(); await f.close(); }
  });
}

test('联系成功后等待新会话进入列表，不重复点击联系', async () => {
  const f = await startBoss({ friends: preceding.slice(0,8), newFriendDelay: 2000 });
  const browser = localBrowser('chat-new-friend');
  const site = createBossSite(bossBrowser(browser, f));
  try {
    assert.equal((await site.openJob(target)).kind, 'canContact');
    const contacted = await site.contact(target);
    assert.equal(contacted.ok, true, contacted.evidence);
    assert.equal((await site.readChat({...target,contactIdentity:contacted.identity})).ourMessages, 0);
    assert.deepEqual([f.contacts, f.sends], [1, []]);
  } finally { await site.close(); await f.close(); }
});
