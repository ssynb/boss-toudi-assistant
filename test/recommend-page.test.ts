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
async function fixture(mode: 'normal' | 'verify' | 'loading-empty' | 'other-first' | 'empty-city') {
  const browser = localBrowser(`recommend-${mode}`);
  const requests: string[] = [];
  const html = `<!doctype html><meta charset="utf-8"><title>推荐</title><div class="nav-figure">账号</div>
<div class="c-expect-select"><a class="synthesis active">推荐</a><a class="expect-item">Python(深圳)</a><a class="expect-item">Python(上海)</a></div>
<div class="page-jobs-main"><ul class="rec-job-list"></ul></div>
<script>
const batches=${JSON.stringify(BATCHES)};
const root=document.querySelector('.page-jobs-main'),state=root.__vue__={isSearch:false,pageVo:{page:0},hasMore:true,loading:true,moreLoading:false,jobList:[],catchExpectId:'',formData:{city:'101280600'}};
const card=id=>'<div class="card-area"><div class="job-card-wrap"><li class="job-card-box" style="height:900px"><div class="job-info"><div class="job-title clearfix"><a href="/job_detail/'+id+'.html" class="job-name">岗位'+id+'</a><span class="job-salary">20-30K</span></div></div><div class="job-card-footer"><a class="boss-info"><span class="boss-name">公司'+id+'</span></a><span class="company-location"> 深圳·南山区 </span></div></li></div></div>';
const append=()=>{const ids=batches[state.pageVo.page].map(id=>state.selected?'py-'+id:id);state.jobList.push(...ids);root.querySelector('ul').insertAdjacentHTML('beforeend',ids.map(card).join(''));state.pageVo.page++;state.hasMore=state.pageVo.page<batches.length;state.loading=false;root.querySelector('.job-empty-box')?.remove();};
// 2026-11-10 真实取证：点击后标签先变为选中，旧列表仍是 loading=false；站点经 100ms 防抖才清空列表、置 loading 并请求新标签的列表接口。
for(const tab of document.querySelectorAll('.expect-item'))tab.onclick=()=>{document.querySelector('.c-expect-select .active')?.classList.remove('active');tab.classList.add('active');
  const expectId=tab.innerText==='Python(深圳)'?'py-expect':'other-expect';state.catchExpectId=expectId;
  // 2026-11-10 真实取证：指定求职方向的请求 city 为显式空串，深圳意向由 expectId 携带。
  state.formData={city:${JSON.stringify(mode)}==='empty-city'&&expectId==='py-expect'?'':tab.innerText.includes('深圳')?'101280600':'101020100'};
  if(['other-first','empty-city'].includes(${JSON.stringify(mode)}))fetch('/wapi/zpgeek/pc/recommend/job/list.json?page=1&encryptExpectId=other-expect&city=101020100');
  if(${JSON.stringify(mode)}==='empty-city')fetch('/wapi/zpgeek/pc/recommend/job/list.json?page=1&encryptExpectId=py-expect');
  setTimeout(async()=>{root.querySelector('ul').innerHTML='';state.jobList=[];state.pageVo.page=0;state.hasMore=true;state.loading=true;state.selected=tab.innerText;
    if(${JSON.stringify(mode)}==='loading-empty')root.insertAdjacentHTML('beforeend','<div class="job-empty-box">加载中</div>');
    const data=(await (await fetch('/wapi/zpgeek/pc/recommend/job/list.json?page=1&encryptExpectId='+expectId+'&city='+state.formData.city)).json()).zpData;
    state.pageVo.page=0;append();state.hasMore=data.hasMore;},100);};
setTimeout(()=>{append();state.loading=false;},300);
addEventListener('scroll',()=>{
  if(state.moreLoading||!state.hasMore||scrollY+innerHeight<document.scrollingElement.scrollHeight-50)return;
  if(${JSON.stringify(mode)}==='verify'&&state.pageVo.page===2){history.replaceState({},'','/web/passport/zp/verify');document.title='安全验证';return;}
  state.moreLoading=true;setTimeout(()=>{append();state.moreLoading=false;},400);
});
</script>`;
  const server = http.createServer((req, res) => {
    requests.push(req.url!);
    if (req.url!.startsWith('/wapi/zpgeek/pc/recommend/job/list.json')) {
      if (req.url!.includes('other-expect') || !new URL(req.url!, 'http://local').searchParams.has('city')) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 0, zpData: { hasMore: false, jobList: [] } }));
      const body = JSON.stringify({ code: 0, zpData: { hasMore: BATCHES.length > 1, jobList: BATCHES[0]!.map(id => ({ encryptJobId: `py-${id}` })) } });
      setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end(body), mode === 'loading-empty' ? 2000 : 100);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const toLocal = (value: string) => value.replaceAll(BOSS, origin);
  const mapped = new Proxy(browser, { get(o, k) {
    if (k === 'open') return (url: string) => o.open(toLocal(url));
    if (k === 'waitFor') return (expr: string, ...args: unknown[]) => Reflect.apply(o.waitFor, o, [toLocal(expr), ...args]);
    if (k === 'eval') return async (expr: string) => { const value = await o.eval(toLocal(expr)); return value === undefined ? value : JSON.parse(JSON.stringify(value).replaceAll(origin, BOSS)); };
    if (k === 'watchResponses') return async (endpoint: string) => {
      const watch = await o.watchResponses(toLocal(endpoint));
      return { get revision() { return watch.revision; }, next: async () => JSON.parse(JSON.stringify(await watch.next()).replaceAll(origin, BOSS)), close: () => watch.close() };
    };
    const v = Reflect.get(o, k, o); return typeof v === 'function' ? v.bind(o) : v;
  } });
  return { site: createBossSite(mapped), requests, async close() { await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('推荐标签按城市打开，同页真实滚动逐批只返回新增岗位，hasMore结束返回空', { timeout: 90_000 }, async () => {
  const f = await fixture('normal');
  try {
    const pages = [];
    for (let page = 1; page <= 4; page++) {
      const result = await f.site.recommend({ city: '深圳', page });
      pages.push([result.cards.map(card => card.jobId), result.exhausted]);
    }
    assert.deepEqual(pages, [[BATCHES[0], false], [BATCHES[1], false], [BATCHES[2], true], [[], true]], '只有站点 hasMore=false 才标记推荐用尽，且最后一批照常返回');
    assert.deepEqual(f.requests.filter(url => url.startsWith('/web/geek/')), ['/web/geek/jobs?city=101280600'], '推荐不带搜索词且整轮只打开一次');
  } finally { await f.close(); }
});

test('推荐卡片提取地区与公司，滚动中出现安全验证即抛出站点阻塞', { timeout: 90_000 }, async () => {
  const f = await fixture('verify');
  try {
    assert.deepEqual((await f.site.recommend({ city: '深圳', page: 1 })).cards.map(card => [card.jobId, card.company, card.area]), BATCHES[0]!.map(id => [id, `公司${id}`, '深圳·南山区']));
    assert.deepEqual((await f.site.recommend({ city: '深圳', page: 2 })).cards.map(card => card.jobId), BATCHES[1]);
    await assert.rejects(f.site.recommend({ city: '深圳', page: 3 }), error => error instanceof SiteBlockedError && error.state.page === 'verify');
  } finally { await f.close(); }
});

test('真实标签导航只选Python深圳，同页续读仍核对标签，标签不存在时拒绝', { timeout: 90_000 }, async () => {
  const f = await fixture('normal');
  try {
    assert.deepEqual((await f.site.recommend({ city: '深圳', page: 1, tab: 'Python(深圳)' })).cards.map(card => card.jobId), BATCHES[0]!.map(id => `py-${id}`));
    assert.deepEqual((await f.site.recommend({ city: '深圳', page: 2, tab: 'Python(深圳)' })).cards.map(card => card.jobId), BATCHES[1]!.map(id => `py-${id}`));
    await assert.rejects(f.site.recommend({ city: '深圳', page: 3, tab: 'Python(上海)' }), /标签|方向/);
    await assert.rejects(f.site.recommend({ city: '深圳', page: 1, tab: '不存在(深圳)' }), /标签|方向/);
  } finally { await f.close(); }
});

test('切换求职方向时旧空占位不代表新标签为空，等待新列表加载完成', { timeout: 90_000 }, async () => {
  const f = await fixture('loading-empty');
  try {
    const { cards } = await f.site.recommend({ city: '深圳', page: 1, tab: 'Python(深圳)' });
    assert.deepEqual(cards.map(card => card.jobId), ['py-a1', 'py-a2', 'py-a3']);
  } finally { await f.close(); }
});

test('切换方向时其他方向或城市的列表响应不算目标方向的结果，更不能当作推荐用尽', { timeout: 90_000 }, async () => {
  const f = await fixture('other-first');
  try {
    const result = await f.site.recommend({ city: '深圳', page: 1, tab: 'Python(深圳)' });
    assert.deepEqual([result.cards.map(card => card.jobId), result.exhausted], [BATCHES[0]!.map(id => `py-${id}`), false]);
  } finally { await f.close(); }
});

test('指定方向的请求城市为显式空串时按空串精确绑定；缺少城市参数或其他方向的响应仍忽略', { timeout: 90_000 }, async () => {
  const f = await fixture('empty-city');
  try {
    const result = await f.site.recommend({ city: '深圳', page: 1, tab: 'Python(深圳)' });
    assert.deepEqual([result.cards.map(card => card.jobId), result.exhausted], [BATCHES[0]!.map(id => `py-${id}`), false]);
  } finally { await f.close(); }
});
