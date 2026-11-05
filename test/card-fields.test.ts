import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createBossSite } from '../src/boss.ts';
import { localBrowser } from './boss-fixture.ts';

const BOSS = 'https://www.zhipin.com';
// 按 2026-11-05 真实职位页只读取证的卡片结构：学历是 .tag-list 中的独立标签，匿名雇主带 .is-anonymous，猎头职位带 img.job-tag-icon[alt="猎头"]。
const cardHtml = (id: string, tags: string[], company: string, extra = '') => `<li class="job-card-box">${extra}<div class="job-info"><div class="job-title clearfix"><a href="/job_detail/${id}.html" class="job-name">岗位${id}</a><span class="job-salary">20-30K</span></div>
<ul class="tag-list">${tags.map(t => `<li>${t}</li>`).join('')}</ul></div>
<div class="job-card-footer"><a href="javascript:;" class="boss-info${company.startsWith('某') ? ' is-anonymous' : ''}"><span class="boss-name">${company}</span></a><span class="company-location"> 深圳·南山区 </span></div></li>`;

test('卡片提取独立学历标签、匿名雇主与猎头图标标识，缺字段不伪造', { timeout: 60_000 }, async () => {
  const browser = localBrowser('card-fields');
  const html = `<!doctype html><meta charset="utf-8"><div class="nav-figure">账号</div><div class="page-jobs-main"><ul>
${cardHtml('master', ['3-5年', '硕士', 'Go'], '深圳甲科技')}
${cardHtml('hunter', ['1-3年', '本科'], '某大型互联网公司', '<img class="job-tag-icon" alt="猎头" src="/x.png">')}
${cardHtml('skill', ['经验不限', '本科', '硕士生导师项目'], '乙科技')}
${cardHtml('none', ['3-5年'], '丙科技')}
</ul></div><script>document.querySelector('.page-jobs-main').__vue__={pageVo:{page:1},hasMore:false,loading:false,moreLoading:false};</script>`;
  const server = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const mapped = new Proxy(browser, { get(o, k) {
    if (k === 'open') return (url: string) => o.open(url.replaceAll(BOSS, origin));
    if (k === 'waitFor') return (expr: string, ...args: unknown[]) => Reflect.apply(o.waitFor, o, [expr.replaceAll(BOSS, origin), ...args]);
    if (k === 'eval') return async (expr: string) => { const value = await o.eval(expr.replaceAll(BOSS, origin)); return value === undefined ? value : JSON.parse(JSON.stringify(value).replaceAll(origin, BOSS)); };
    const v = Reflect.get(o, k, o); return typeof v === 'function' ? v.bind(o) : v;
  } });
  try {
    const cards = await createBossSite(mapped).search({ keyword: '后端', city: '深圳', page: 1 });
    assert.deepEqual(cards.map(c => [c.jobId, c.company, c.degree ?? null, Boolean(c.anonymous), c.markers ?? []]), [
      ['master', '深圳甲科技', '硕士', false, []],
      ['hunter', '某大型互联网公司', '本科', true, ['猎头']],
      ['skill', '乙科技', '本科', false, []],
      ['none', '丙科技', null, false, []],
    ]);
  } finally { await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
