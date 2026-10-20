import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Browser } from '../src/browser.ts';
import { createBossSite } from '../src/boss.ts';
import type { Target } from '../src/contracts.ts';
import { tempDir } from './helpers.ts';

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

const target = { jobId: 'jobA', company: '公司', url: 'https://www.zhipin.com/job_detail/jobA.html' } as Target;
const chat = `<!doctype html><meta charset="utf-8"><div class="nav-figure">账号</div>
<div class="chat-user"><div class="chat-content"><ul><li role="listitem"><div class="friend-content-warp">已有会话</div></li></ul></div></div>
<div class="chat-conversation"><div class="top-info-content"></div><div class="chat-record"></div></div>
<script>
const selected={encryptJobId:'jobA',encryptBossId:'bossA'}, header={...selected,companyName:'公司'};
const item=document.querySelector('li');item.__vue__={$props:{source:selected}};
function load(){document.querySelector('.chat-conversation').__vue__={selectedFriend$:selected};document.querySelector('.top-info-content').__vue__={conversation$:header};document.querySelector('.chat-record').__vue__={selectedFriend$:selected,conversation$:header};}
item.onclick=load;
if(location.hash==='#selected')load();
</script>`;

for (const mode of ['popup', 'new-tab', 'same-tab'] as const) {
  test(`联系后 ${mode} 去向能核对原岗位和招聘者，不重复联系`, async () => {
    const dir = tempDir('boss-contact-navigation-');
    fs.writeFileSync(path.join(dir, 'chat.html'), chat);
    const action = mode === 'popup' ? "document.querySelector('.startchat-dialog').hidden=false" : `window.open('chat.html#selected','${mode === 'new-tab' ? '_blank' : '_self'}')`;
    fs.writeFileSync(path.join(dir, 'page.html'), `<!doctype html><meta charset="utf-8"><div class="nav-figure">账号</div>
<a class="btn-startchat" href="javascript:;" redirect-url="https://www.zhipin.com/web/geek/chat?id=bossA&jobId=jobA" onclick="sessionStorage.setItem('contacts',String(Number(sessionStorage.getItem('contacts')||0)+1));${action}">立即沟通</a>
<div class="startchat-dialog" hidden><textarea></textarea></div>`);
    const browser = new Browser({ profileDir: path.join(dir, 'profile'), headed: false, namespace: `navigation-${process.pid}` });
    try {
      const site = localSite(browser, dir);
      assert.equal((await site.openJob(target)).kind, 'canContact');
      const result = await site.contact(target);
      assert.equal(result.ok, true, result.evidence);
      assert.deepEqual(result.identity, { kind: 'chatId', jobId: 'jobA', recruiterId: 'bossA' });
      assert.equal(await browser.eval("sessionStorage.getItem('contacts')"), '1');
    } finally { await browser.close(); }
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
