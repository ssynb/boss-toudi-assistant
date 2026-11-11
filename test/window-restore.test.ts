import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Browser } from '../src/browser.ts';
import { createBossSite } from '../src/boss.ts';
import { tempDir } from './helpers.ts';

const BOSS = 'https://www.zhipin.com';
const BATCHES = [['a1', 'a2'], ['b1', 'b2'], ['c1']];

/** 测试侧经 DevToolsActivePort 直连同一 Cloak，制造用户侧的窗口/标签变化；生产代码只经 agent-browser。 */
async function devtools(profileDir: string) {
  const [port, pathname] = fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}`);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let id = 0;
  const send = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
    const call = ++id;
    const listener = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== call) return;
      ws.removeEventListener('message', listener);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
    };
    ws.addEventListener('message', listener);
    ws.send(JSON.stringify({ id: call, method, params }));
  });
  return { send, close: () => ws.close() };
}

/** 真实推荐页形态：窗口 scroll 事件触发加载下一批；页面不可见时没有渲染时机，scroll 事件不派发。 */
async function fixture(name: string, headed: boolean) {
  const profileDir = path.join(tempDir(`boss-${name}-`), 'profile');
  const browser = new Browser({ profileDir, headed, namespace: `${name}-${process.pid}` });
  const html = `<!doctype html><meta charset="utf-8"><title>推荐</title><div class="nav-figure">账号</div>
<div class="page-jobs-main"><ul></ul></div>
<script>
const batches=${JSON.stringify(BATCHES)};
const root=document.querySelector('.page-jobs-main'),state=root.__vue__={pageVo:{page:0},hasMore:true,loading:false,moreLoading:false};
const append=()=>{root.querySelector('ul').insertAdjacentHTML('beforeend',batches[state.pageVo.page].map(id=>'<li class="job-card-box" style="height:900px"><a href="/job_detail/'+id+'.html" class="job-name">岗位</a><span class="company-location">深圳</span></li>').join(''));state.pageVo.page++;state.hasMore=state.pageVo.page<batches.length;};
append();
addEventListener('scroll',()=>{if(state.moreLoading||!state.hasMore||scrollY+innerHeight<document.scrollingElement.scrollHeight-50)return;state.moreLoading=true;setTimeout(()=>{append();state.moreLoading=false;},200);});
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
  const site = createBossSite(mapped);
  assert.deepEqual((await site.recommend({ city: '深圳', page: 1 })).cards.map(card => card.jobId), BATCHES[0]);
  const cdp = await devtools(profileDir);
  const pages = async () => (await cdp.send('Target.getTargets')).targetInfos.filter((t: { type: string }) => t.type === 'page') as { targetId: string; url: string }[];
  const [own] = (await pages()).filter(t => t.url.startsWith(origin));
  assert.ok(own);
  return { site, cdp, own, pages, async close() { cdp.close(); await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

// 2026-11-02 生产现场：同一 Cloak 窗口有 chrome://newtab 与本应用两个标签，agent-browser 只列出本应用标签。
test('其他标签切到前台使本应用页面不可见时，切回同一标签继续滚动加载，不关闭其他标签', { timeout: 90_000 }, async () => {
  const f = await fixture('restore-tab', false);
  try {
    const other = await f.cdp.send('Target.createTarget', { url: 'chrome://newtab/' });
    assert.deepEqual((await f.site.recommend({ city: '深圳', page: 2 })).cards.map(card => card.jobId), BATCHES[1]);
    assert.deepEqual((await f.site.recommend({ city: '深圳', page: 3 })).cards.map(card => card.jobId), BATCHES[2]);
    const ids = (await f.pages()).map(t => t.targetId);
    assert.ok(ids.includes(f.own.targetId) && ids.includes(other.targetId), '恢复的是原标签页，其他标签保留');
  } finally { await f.close(); }
});

test('窗口被最小化时恢复本应用窗口后继续滚动加载', { timeout: 90_000 }, async () => {
  const f = await fixture('restore-minimized', true);
  try {
    const { windowId } = await f.cdp.send('Browser.getWindowForTarget', { targetId: f.own.targetId });
    await f.cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    assert.deepEqual((await f.site.recommend({ city: '深圳', page: 2 })).cards.map(card => card.jobId), BATCHES[1]);
    assert.equal((await f.cdp.send('Browser.getWindowForTarget', { targetId: f.own.targetId })).bounds.windowState, 'normal');
  } finally { await f.close(); }
});
