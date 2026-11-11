import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createBossSite, SiteBlockedError } from '../src/boss.ts';
import { localBrowser } from './boss-fixture.ts';

const BOSS = 'https://www.zhipin.com';

/**
 * 2026-11-02 真实失败：Cloak 窗口被最小化/隐藏时页面 visibilityState=hidden，没有渲染时机，
 * 职位页的 window scroll 事件不派发，滚到底也不会请求下一批。夹具以页面报告 hidden 且滚动不加载模拟这一状态。
 */
async function fixture() {
  const browser = localBrowser('hidden-window');
  const html = `<!doctype html><meta charset="utf-8"><title>推荐</title><div class="nav-figure">账号</div>
<div class="page-jobs-main"><ul><li class="job-card-box" style="height:2000px"><a href="/job_detail/a1.html" class="job-name">岗位</a><span class="company-location">深圳</span></li></ul></div>
<script>
Object.defineProperty(document,'visibilityState',{get:()=>'hidden'});Object.defineProperty(document,'hidden',{get:()=>true});
document.querySelector('.page-jobs-main').__vue__={pageVo:{page:1},hasMore:true,loading:false,moreLoading:false};
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

test('浏览器窗口不可见时翻页立即作为站点阻塞停止并提示恢复窗口，不等待超时', { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    assert.deepEqual((await f.site.recommend({ city: '深圳', page: 1 })).cards.map(card => card.jobId), ['a1']);
    const started = Date.now();
    await assert.rejects(f.site.recommend({ city: '深圳', page: 2 }), error => error instanceof SiteBlockedError && /窗口/.test(error.message));
    assert.ok(Date.now() - started < 6_000, '不能等满滚动超时再报告');
    await assert.rejects(f.site.search({ keyword: '前端', city: '深圳', page: 2 }), error => error instanceof SiteBlockedError && /窗口/.test(error.message));
  } finally { await f.close(); }
});
