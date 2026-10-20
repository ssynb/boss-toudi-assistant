import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBossSite } from '../src/boss.ts';
import type { Target } from '../src/contracts.ts';
import { bossBrowser, draft, localBrowser, startBoss, TARGET, UID, message } from './boss-fixture.ts';

const target = { ...draft(), contactIdentity: { kind: 'chatId', jobId: TARGET.jobId, recruiterId: TARGET.bossId } } as Target;
const items = '.chat-user .chat-content li[role="listitem"]';

for (const [name, messages] of [
  ['缺少双方', [{ mid: 1 }]],
  ['缺少发送者', [{ mid: 1, to: { uid: UID } }]],
  ['缺少接收者', [{ mid: 1, from: { uid: TARGET.friendId } }]],
  ['第三方发给当前账号', [message(1, false, '未知发送者', 99)]],
  ['招聘者发给其他账号', [{ ...message(1, false, '其他账号'), to: { uid: 99 } }]],
  ['双方都不属于当前会话', [{ mid: 1, from: { uid: 98 }, to: { uid: 99 } }]],
  ['有效本方消息不能掩盖另一条归属缺失', [message(1, true, '已发送'), { mid: 2 }]],
] as const) {
  test(`历史必须逐条证明双向归属：${name}`, async () => {
    const f = await startBoss({ friends: [TARGET], history: () => ({ status: 200, body: { code: 0, zpData: { messages, hasMore: false } } }) });
    const browser = localBrowser('chat-proof');
    const site = createBossSite(bossBrowser(browser, f));
    try {
      const opened = await site.openJob(target);
      assert.equal(opened.kind, 'blocked');
      assert.match(opened.evidence, /归属/);
      await assert.rejects(site.readChat(target), /归属/);
      assert.deepEqual([f.contacts, f.sends], [0, []]);
    } finally { await site.close(); await f.close(); }
  });
}

for (const change of ['reload', 'switch-back'] as const) {
  test(`完整空历史证明不得跨越${change}后的失败历史复用`, async () => {
    const f = await startBoss({ friends: [TARGET, { ...TARGET, jobId: 'other', bossId: 'other', friendId: 9 }] });
    const browser = localBrowser('chat-proof');
    const site = createBossSite(bossBrowser(browser, f));
    try {
      assert.equal((await site.readChat(target)).ourMessages, 0);
      f.scenario.history = () => ({ status: 500, body: {} });
      if (change === 'reload') {
        await browser.open(f.origin + '/web/geek/chat?id=bossA&jobId=jobA');
        await browser.waitFor('document.querySelector(".chat-conversation").__vue__?.selectedFriend$?.encryptJobId === "jobA"');
      } else {
        await browser.clickSelector(items + ':nth-child(2)');
        await browser.clickSelector(items + ':nth-child(1)');
      }
      await assert.rejects(site.sendGreeting(target, '不能发送'), /历史/);
      assert.deepEqual(f.sends, []);
    } finally { await site.close(); await f.close(); }
  });
}

test('填写过程中同一空会话重新请求历史，即使 DOM 和身份不变也拒绝提交', async () => {
  const f = await startBoss({ friends: [TARGET] });
  const browser = localBrowser('chat-proof');
  const site = createBossSite(bossBrowser(browser, f));
  try {
    assert.equal((await site.readChat(target)).ourMessages, 0);
    f.scenario.history = () => ({ status: 500, body: {} });
    // 合成站点的输入行为触发重新选择当前会话；不是替换生产核对结果。
    await browser.eval(`(document.getElementById('chat-input').addEventListener('input', () => document.querySelector(${JSON.stringify(items)}).click(), {once:true}), true)`);
    const result = await site.sendGreeting(target, '不能发送');
    assert.equal(result.ok, false, result.evidence);
    assert.deepEqual(f.sends, []);
  } finally { await site.close(); await f.close(); }
});
