import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBossSite, validateSearchQuery } from '../src/boss.ts';
import type { Target } from '../src/contracts.ts';
import { bossBrowser, draft, localBrowser, startBoss, TARGET } from './boss-fixture.ts';

for (const sameRecruiter of [true, false]) {
  test(`继续沟通缺少本岗位会话：${sameRecruiter ? '同招聘者其他岗位只跳过' : '只有其他招聘者则阻塞'}`, async () => {
    const f = await startBoss({ continued: true, friends: [{ ...TARGET, jobId: 'other-job', bossId: sameRecruiter ? TARGET.bossId : 'other-boss' }] });
    const browser = localBrowser('recruiter-dedup');
    const site = createBossSite(bossBrowser(browser, f));
    const target = { ...draft(), contactIdentity: { kind: 'chatId', jobId: TARGET.jobId, recruiterId: TARGET.bossId } } as Target;
    try {
      const result = await site.openJob(target);
      assert.equal(result.kind, sameRecruiter ? 'alreadyContacted' : 'blocked', result.evidence);
      if (sameRecruiter) assert.match(result.evidence, /同.*招聘者.*其他岗位/);
      await assert.rejects(site.sendGreeting(target, '不可发送'), /会话/);
      assert.deepEqual([f.contacts, f.sends, f.historyRequests], [0, [], []]);
    } finally { await site.close(); await f.close(); }
  });
}

test('搜索允许第六至第十批，拒绝第十一批', () => {
  for (let page = 6; page <= 10; page++) assert.doesNotThrow(() => validateSearchQuery({ keyword: '前端', city: '深圳', page }));
  assert.throws(() => validateSearchQuery({ keyword: '前端', city: '深圳', page: 11 }), /搜索参数/);
});
