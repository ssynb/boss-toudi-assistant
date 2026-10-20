import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createBossSite } from '../src/boss.ts';
import type { Target } from '../src/contracts.ts';
import { bossBrowser, localBrowser, startBoss, TARGET } from './boss-fixture.ts';

const browser = localBrowser('contact-popup');
after(() => browser.close());
const target = { jobId: TARGET.jobId, company: TARGET.company, url: 'https://www.zhipin.com/job_detail/jobA.html' } as Target;
const decoys = [{ ...TARGET, jobId: 'jobB' }, { ...TARGET, bossId: 'bossB', friendId: 9 }];

for (const present of [true, false]) {
  test(`聊天弹层只进入岗位与招聘者同时匹配的已有会话（目标${present ? '存在' : '不存在'}）`, async () => {
    const f = await startBoss({ friends: [...decoys], createsFriend: present });
    const site = createBossSite(bossBrowser(browser, f));
    try {
      assert.equal((await site.openJob(target)).kind, 'canContact');
      const result = await site.contact(target);
      assert.equal(result.ok, present, result.evidence);
      assert.equal(f.contacts, 1);
      const selected = await browser.eval<{ encryptJobId: string; encryptBossId: string } | null>('document.querySelector(".chat-conversation").__vue__?.selectedFriend$ ?? null');
      if (present) assert.deepEqual([selected?.encryptJobId, selected?.encryptBossId], [TARGET.jobId, TARGET.bossId]);
      else assert.equal(selected, null, '目标不存在时不能选中其他会话');
    } finally { await f.close(); }
  });
}

for (const [name, change, contacts] of [
  ['入口被页面改成「继续沟通」', `document.querySelector('.btn-startchat').textContent='继续沟通'`, 0],
  ['招聘者身份在点击前变化', `document.querySelector('.btn-startchat').setAttribute('redirect-url','/web/geek/chat?id=bossB&jobId=jobA')`, 0],
  ['页面重渲染使旧引用失效', `document.body.insertAdjacentHTML('afterbegin','<a href="javascript:;">其他链接</a><button>收藏</button>')`, 1],
] as const) {
  test(`联系前在岗位页重新定位与复核身份：${name}`, async () => {
    const f = await startBoss();
    const site = createBossSite(bossBrowser(browser, f));
    try {
      assert.equal((await site.openJob(target)).kind, 'canContact');
      await browser.eval(change);
      const result = await site.contact(target);
      assert.equal(result.ok, contacts === 1, result.evidence);
      assert.equal(f.contacts, contacts);
    } finally { await f.close(); }
  });
}
