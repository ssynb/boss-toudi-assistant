import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createBossSite, SiteBlockedError } from '../src/boss.ts';
import { localBrowser } from './boss-fixture.ts';

const BOSS = 'https://www.zhipin.com';
const BATCHES = [['a1', 'a2', 'a3'], ['b1', 'b2'], ['c1']];

/** 推荐页在加载后异步渲染首批；滚到底后延迟整表重绘（旧卡片节点被替换），批次用尽后不再增加。 */
async function fixture(mode: 'normal' | 'verify') {
  const browser = localBrowser(`recommend-${mode}`);
  const html = `<!doctype html><meta charset="utf-8"><title>推荐</title><div class="nav-figure">账号</div><ul class="rec-list"></ul>
<script>
const batches=${JSON.stringify(BATCHES)};let shown=0,busy=false;
const card=id=>'<li style="height:900px"><a href="/job_detail/'+id+'.html?lid=x"><span class="job-name">岗位'+id+'</span></a><span class="salary">20-30K</span><span class="company-name">公司'+id+'</span><span class="job-area">深圳·南山区</span></li>';
const render=()=>{document.querySelector('.rec-list').innerHTML=batches.slice(0,shown).flat().map(card).join('');};
setTimeout(()=>{shown=1;render();},300);
addEventListener('scroll',()=>{
  if(busy||shown===0||scrollY+innerHeight<document.scrollingElement.scrollHeight-50)return;
  if(${JSON.stringify(mode)}==='verify'&&shown===2){history.replaceState({},'','/web/passport/zp/verify');document.title='安全验证';return;}
  if(shown>=batches.length)return;
  busy=true;setTimeout(()=>{shown++;render();busy=false;},400);
});
</script>`;
  const server = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const toLocal = (value: string) => value.replaceAll(BOSS, origin);
  const mapped = new Proxy(browser, { get(o, k) {
    if (k === 'open') return (url: string) => o.open(toLocal(url));
    if (k === 'waitFor') return (expr: string, ...args: unknown[]) => Reflect.apply(o.waitFor, o, [toLocal(expr), ...args]);
    if (k === 'eval') return async (expr: string) => { const value = await o.eval(toLocal(expr)); return value === undefined ? value : JSON.parse(JSON.stringify(value).replaceAll(origin, BOSS)); };
    const v = Reflect.get(o, k, o); return typeof v === 'function' ? v.bind(o) : v;
  } });
  return { site: createBossSite(mapped), async close() { await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('推荐页真实滚动逐批只返回新增岗位，整表重绘不重复，用尽返回空', { timeout: 90_000 }, async () => {
  const f = await fixture('normal');
  try {
    const pages = [];
    for (let page = 1; page <= 4; page++) pages.push((await f.site.recommend(page)).map(card => card.jobId));
    assert.deepEqual(pages, [...BATCHES, []]);
  } finally { await f.close(); }
});

test('推荐页滚动中出现安全验证即抛出站点阻塞', { timeout: 90_000 }, async () => {
  const f = await fixture('verify');
  try {
    assert.deepEqual((await f.site.recommend(1)).map(card => [card.jobId, card.area]), BATCHES[0]!.map(id => [id, '深圳·南山区']));
    assert.deepEqual((await f.site.recommend(2)).map(card => card.jobId), BATCHES[1]);
    await assert.rejects(f.site.recommend(3), error => error instanceof SiteBlockedError && error.state.page === 'verify');
  } finally { await f.close(); }
});
