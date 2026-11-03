import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBossSite } from '../src/boss.ts';
import type { Target } from '../src/contracts.ts';
import { bossBrowser, draft, localBrowser, startBoss, TARGET } from './boss-fixture.ts';

const target = { ...draft(), contactIdentity: { kind: 'chatId', jobId: TARGET.jobId, recruiterId: TARGET.bossId } } as Target;

// 2026-11-02 真实失败：页面不可见时站点 100ms 防抖被推迟，填写后按钮晚于固定安静窗口才启用，招呼未发送。
test('发送按钮晚于输入稳定才启用时等待站点启用后再发送', { timeout: 60_000 }, async () => {
  const f = await startBoss({ friends: [TARGET], sendEnableDelay: 1500 });
  const site = createBossSite(bossBrowser(localBrowser('send-late'), f));
  try {
    const result = await site.sendGreeting(target, '定制招呼');
    assert.equal(result.ok, true, result.evidence);
    assert.deepEqual(f.sends, ['定制招呼']);
  } finally { await site.close(); await f.close(); }
});

test('发送按钮始终不可用时不提交', { timeout: 60_000 }, async () => {
  const f = await startBoss({ friends: [TARGET], sendEnableDelay: 'never' });
  const site = createBossSite(bossBrowser(localBrowser('send-never'), f));
  try {
    const result = await site.sendGreeting(target, '定制招呼');
    assert.deepEqual([result.ok, result.evidence], [false, '发送按钮不可用，未发送']);
    assert.deepEqual(f.sends, []);
  } finally { await site.close(); await f.close(); }
});
