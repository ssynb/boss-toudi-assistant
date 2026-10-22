import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBossSite } from '../src/boss.ts';
import type { ResponseWatch } from '../src/browser-responses.ts';
import type { Target } from '../src/contracts.ts';
import { bossBrowser, draft, localBrowser, startBoss, TARGET } from './boss-fixture.ts';

const target = draft() as Target;

for (const nextPage of ['jobDetail', 'search'] as const) test(`连续读JD后不再次导航；联系后切换${nextPage}释放历史观察`, async () => {
  const f = await startBoss();
  const browser = localBrowser('job-reuse');
  const mapped = bossBrowser(browser, f);
  const watches: ResponseWatch[] = [];
  const observed = new Proxy(mapped, {get(o,k){
    if(k==='watchResponses')return async(endpoint:string)=>{const watch=await o.watchResponses(endpoint);watches.push(watch);return watch;};
    const value=Reflect.get(o,k,o);return typeof value==='function'?value.bind(o):value;
  }});
  const site = createBossSite(observed);
  try {
    assert.match(await site.jobDetail(target), /岗位职责/);
    assert.equal((await site.openJob(target)).kind, 'canContact');
    assert.deepEqual(f.jobVisits, ['jobA']);
    const contacted = await site.contact(target);
    assert.equal(contacted.ok, true, contacted.evidence);
    const saved = { ...target, contactIdentity: contacted.identity };
    assert.equal((await site.readChat(saved)).ourMessages, 0);
    assert.equal(watches.length, 1);
    if (nextPage === 'jobDetail') assert.match(await site.jobDetail({jobId:'next',url:'https://www.zhipin.com/job_detail/next.html'}), /岗位职责/);
    else assert.deepEqual(await site.search({keyword:'前端',city:'深圳',page:1}), []);
    assert.throws(() => watches[0]!.revision, /关闭/);
    f.scenario.history = () => ({status:500,body:{}});
    await assert.rejects(site.readChat(saved), /历史/);
    assert.deepEqual([f.contacts, f.sends], [1, []]);
    assert.deepEqual(f.jobVisits, nextPage === 'jobDetail' ? ['jobA', 'next'] : ['jobA']);
  } finally { await site.close(); await f.close(); }
});

for (const changed of ['recruiter', 'duplicate-entry', 'continue-entry'] as const) {
  test(`复用岗位页仍重新核对沟通入口和身份：${changed}`, async () => {
    const f = await startBoss();
    const browser = localBrowser('job-reuse-identity');
    const site = createBossSite(bossBrowser(browser, f));
    try {
      await site.jobDetail(target);
      if (changed === 'recruiter') await browser.eval(`(document.querySelector('.btn-startchat').setAttribute('redirect-url','/web/geek/chat?id=changed&jobId=wrong-job'), true)`);
      if (changed === 'duplicate-entry') await browser.eval(`(document.querySelector('.btn-startchat').insertAdjacentHTML('afterend','<button>立即沟通</button>'), true)`);
      if (changed === 'continue-entry') await browser.eval(`(document.querySelector('.btn-startchat').textContent='继续沟通', true)`);
      const result = await site.openJob(target);
      assert.equal(result.kind, 'blocked', result.evidence);
      assert.deepEqual(f.jobVisits, [TARGET.jobId]);
      assert.deepEqual([f.contacts, f.sends], [0, []]);
    } finally { await site.close(); await f.close(); }
  });
}

for (const changed of ['other-job', 'logged-out', 'not-loaded'] as const) {
  test(`当前页已变化或不就绪时重新导航：${changed}`, async () => {
    const f = await startBoss();
    const browser = localBrowser('job-reuse-navigate');
    const site = createBossSite(bossBrowser(browser, f));
    try {
      await site.jobDetail(target);
      if (changed === 'other-job') await browser.open(f.origin+'/job_detail/other.html');
      if (changed === 'logged-out') await browser.eval(`(document.querySelector('.nav-figure').remove(), document.body.insertAdjacentHTML('beforeend','<button>登录</button>'), true)`);
      if (changed === 'not-loaded') await browser.eval(`(Object.defineProperty(document,'readyState',{value:'loading',configurable:true}), true)`);
      assert.equal((await site.openJob(target)).kind, 'canContact');
      assert.deepEqual(f.jobVisits, changed === 'other-job' ? ['jobA','other','jobA'] : ['jobA','jobA']);
      assert.equal(f.contacts, 0);
    } finally { await site.close(); await f.close(); }
  });
}
