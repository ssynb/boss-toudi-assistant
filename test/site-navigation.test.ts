import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Browser } from '../src/browser.ts';
import { createBossSite } from '../src/boss.ts';
import { tempDir } from './helpers.ts';
import { openState } from '../src/state.ts';
import { Executor } from '../src/executor.ts';
import { bossBrowser, draft, localBrowser, startBoss, TARGET } from './boss-fixture.ts';

function localSite(browser: Browser, dir: string) {
  // 只替换站点来源与导航；DOM、滚动、点击、弹层、新标签页和身份脚本均由真实 Cloak 执行。
  return createBossSite(new Proxy(browser, {
    get(object, key) {
      if (key === 'open') return (url: string) => object.open(pathToFileURL(path.join(dir, new URL(url).pathname.includes('/chat') ? 'chat.html' : 'page.html')).href);
      if (key === 'waitFor') return (expression: string) => object.waitFor(expression.replaceAll('location.origin === "https://www.zhipin.com"', 'true').replaceAll('location.pathname.startsWith("/web/geek/chat")', 'location.pathname.endsWith("/chat.html")'));
      if (key === 'eval') return async (expression: string) => {
        if (expression === 'location.pathname') return (await object.eval<string>('location.pathname')).endsWith('/chat.html') ? '/web/geek/chat' : '/job_detail/jobA.html';
        const result = await object.eval<unknown>(expression);
        if (result && typeof result === 'object' && 'hasAccount' in result) return { ...result, url: 'https://www.zhipin.com' + ((await object.eval<string>('location.pathname')).endsWith('/chat.html') ? '/web/geek/chat' : '/job_detail/jobA.html') };
        return result;
      };
      const value = Reflect.get(object, key, object);
      return typeof value === 'function' ? value.bind(object) : value;
    },
  }));
}

for (const destination of ['popup', 'route', 'new-tab'] as const) {
  test(`完整切片（${destination}）：读岗位→批准→联系→进入确切已有会话→完整空历史→填写复核→发送回显→再次运行不重复`, async () => {
    const f = await startBoss({ destination, friends: [{ ...TARGET, jobId: 'jobB' }, { ...TARGET, bossId: 'bossB', friendId: 9 }] });
    const browser = localBrowser(`slice-${destination}`);
    const site = createBossSite(bossBrowser(browser, f));
    const dir = tempDir('boss-slice-');
    try {
      assert.match(await site.jobDetail({ jobId: TARGET.jobId, url: draft().url }), /岗位职责/);
      const state = openState(path.join(dir, 'state.sqlite'));
      state.replaceBatch([draft()]);
      state.approve(state.snapshot().batch!.version);
      await new Executor(state, site).start();
      const done = state.snapshot().batch!;
      assert.equal(done.status, 'done', done.stopReason ?? '');
      assert.deepEqual(done.targets[0]!.steps, { contact: 'done', greeting: 'done' });
      assert.deepEqual(done.targets[0]!.contactIdentity, { kind: 'chatId', jobId: TARGET.jobId, recruiterId: TARGET.bossId });
      assert.deepEqual([f.contacts, f.sends], [1, ['定制招呼']]);

      // 同一账本再批一次：已联系，不再打开联系入口。
      state.replaceBatch([draft('另一段招呼')]);
      state.approve(state.snapshot().batch!.version);
      await new Executor(state, site).start();
      assert.deepEqual(state.snapshot().batch!.targets[0]!.steps, { contact: 'skipped', greeting: 'skipped' });
      state.close();

      // 账本丢失招呼结果（联系已完成、招呼待办）：新进程只读进入已有会话，历史里的本方消息使其跳过。
      const resumed = openState(path.join(dir, 'resumed.sqlite'));
      const batch = resumed.replaceBatch([draft('另一段招呼')]);
      resumed.approve(batch.version);
      resumed.beginRun();
      resumed.setStep(batch.targets[0]!, 'contact', 'done', '', done.targets[0]!.contactIdentity);
      resumed.finishRun('paused', null);
      await new Executor(resumed, createBossSite(bossBrowser(browser, f))).start();
      assert.deepEqual(resumed.snapshot().batch!.targets[0]!.steps, { contact: 'done', greeting: 'skipped' });
      resumed.close();
      assert.deepEqual([f.contacts, f.sends], [1, ['定制招呼']]);
    } finally { await browser.close(); await f.close(); }
  });
}

test('分页通过真实滚动加载后续岗位；结果耗尽不重复第一页', async () => {
  const dir = tempDir('boss-search-navigation-');
  fs.writeFileSync(path.join(dir, 'page.html'), `<!doctype html><meta charset="utf-8"><div class="nav-figure">账号</div><div class="page-jobs-main"><ul></ul></div><script>
const root=document.querySelector('.page-jobs-main');
const state=root.__vue__={pageVo:{page:1},loading:false,moreLoading:false,hasMore:true};
function append(){root.querySelector('ul').insertAdjacentHTML('beforeend','<li class="job-card-box" style="height:1200px"><a href="https://www.zhipin.com/job_detail/p'+state.pageVo.page+'.html"><span class="job-name">岗位</span></a></li>');}
append();addEventListener('scroll',()=>{if(scrollY+innerHeight<document.scrollingElement.scrollHeight-100||state.moreLoading||!state.hasMore)return;state.moreLoading=true;setTimeout(()=>{state.pageVo.page++;append();state.hasMore=state.pageVo.page<3;state.moreLoading=false;},50);});
</script>`);
  const browser = new Browser({ profileDir: path.join(dir, 'profile'), headed: false, namespace: `pagination-${process.pid}` });
  try {
    const site = localSite(browser, dir);
    for (let page = 1; page <= 4; page++) {
      assert.deepEqual((await site.search({ keyword: '前端', city: '深圳', page })).map(card => card.jobId), page <= 3 ? [`p${page}`] : []);
    }
  } finally { await browser.close(); }
});
