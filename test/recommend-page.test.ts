import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createBossSite, SiteBlockedError } from '../src/boss.ts';
import { localBrowser } from './boss-fixture.ts';

const BOSS = 'https://www.zhipin.com';
const BATCHES = [['a1', 'a2', 'a3'], ['b1', 'b2'], ['c1']];

/**
 * 按 2026-11-01 只读取证的真实推荐页形态：职位页「推荐」标签（无搜索词、带城市参数），
 * 页面 Vue 状态带 pageVo/hasMore/moreLoading，加载后异步渲染，滚到文档底部才追加下一批，最后一批 hasMore=false。
 */
async function fixture(mode: 'normal' | 'verify') {
  const browser = localBrowser(`recommend-${mode}`);
  const requests: string[] = [];
  const html = `<!doctype html><meta charset="utf-8"><title>推荐</title><div class="nav-figure">账号</div>
<div class="page-jobs-main"><ul class="rec-job-list"></ul></div>
<script>
const batches=${JSON.stringify(BATCHES)};
const root=document.querySelector('.page-jobs-main'),state=root.__vue__={isSearch:false,pageVo:{page:0},hasMore:true,loading:true,moreLoading:false};
const card=id=>'<div class="card-area"><div class="job-card-wrap"><li class="job-card-box" style="height:900px"><div class="job-info"><div class="job-title clearfix"><a href="/job_detail/'+id+'.html" class="job-name">岗位'+id+'</a><span class="job-salary">20-30K</span></div></div><div class="job-card-footer"><a class="boss-info"><span class="boss-name">公司'+id+'</span></a><span class="company-location"> 深圳·南山区 </span></div></li></div></div>';
const append=()=>{root.querySelector('ul').insertAdjacentHTML('beforeend',batches[state.pageVo.page].map(card).join(''));state.pageVo.page++;state.hasMore=state.pageVo.page<batches.length;};
setTimeout(()=>{append();state.loading=false;},300);
addEventListener('scroll',()=>{
  if(state.moreLoading||!state.hasMore||scrollY+innerHeight<document.scrollingElement.scrollHeight-50)return;
  if(${JSON.stringify(mode)}==='verify'&&state.pageVo.page===2){history.replaceState({},'','/web/passport/zp/verify');document.title='安全验证';return;}
  state.moreLoading=true;setTimeout(()=>{append();state.moreLoading=false;},400);
});
</script>`;
  const server = http.createServer((req, res) => { requests.push(req.url!); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const toLocal = (value: string) => value.replaceAll(BOSS, origin);
  const mapped = new Proxy(browser, { get(o, k) {
    if (k === 'open') return (url: string) => o.open(toLocal(url));
    if (k === 'waitFor') return (expr: string, ...args: unknown[]) => Reflect.apply(o.waitFor, o, [toLocal(expr), ...args]);
    if (k === 'eval') return async (expr: string) => { const value = await o.eval(toLocal(expr)); return value === undefined ? value : JSON.parse(JSON.stringify(value).replaceAll(origin, BOSS)); };
    const v = Reflect.get(o, k, o); return typeof v === 'function' ? v.bind(o) : v;
  } });
  return { site: createBossSite(mapped), requests, async close() { await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('推荐标签按城市打开，同页真实滚动逐批只返回新增岗位，hasMore结束返回空', { timeout: 90_000 }, async () => {
  const f = await fixture('normal');
  try {
    const pages = [];
    for (let page = 1; page <= 4; page++) pages.push((await f.site.recommend({ city: '深圳', page })).map(card => card.jobId));
    assert.deepEqual(pages, [...BATCHES, []]);
    assert.deepEqual(f.requests.filter(url => url.startsWith('/web/geek/')), ['/web/geek/jobs?city=101280600'], '推荐不带搜索词且整轮只打开一次');
  } finally { await f.close(); }
});

test('推荐卡片提取地区与公司，滚动中出现安全验证即抛出站点阻塞', { timeout: 90_000 }, async () => {
  const f = await fixture('verify');
  try {
    assert.deepEqual((await f.site.recommend({ city: '深圳', page: 1 })).map(card => [card.jobId, card.company, card.area]), BATCHES[0]!.map(id => [id, `公司${id}`, '深圳·南山区']));
    assert.deepEqual((await f.site.recommend({ city: '深圳', page: 2 })).map(card => card.jobId), BATCHES[1]);
    await assert.rejects(f.site.recommend({ city: '深圳', page: 3 }), error => error instanceof SiteBlockedError && error.state.page === 'verify');
  } finally { await f.close(); }
});
