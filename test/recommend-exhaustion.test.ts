import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/server.ts';
import type { JobCard, ListPage } from '../src/boss.ts';
import type { AppState } from '../src/contracts.ts';
import { countedSite, instantReadClock, tempDir, api, type FakeSite } from './helpers.ts';
import { mockProviderToml, ruleModel, startMockModel } from './mock-responses.ts';

const TAB = 'Python(深圳)';
const card = (jobId: string): JobCard => ({ jobId, area: '深圳·南山区', salary: '20-40K', title: 'Python开发', company: `${jobId}科技`, snippet: '', url: `https://www.zhipin.com/job_detail/${jobId}.html`, degree: '本科' });
const page = (ids: string[], exhausted: boolean): ListPage => ({ cards: ids.map(card), exhausted });

type Feed = { recommend: (page: number) => ListPage; search?: (page: number) => ListPage };

/**
 * 指定求职方向标签的发现。requirements 写「推荐来源」与可选的「推荐耗尽后搜索补充：允许」；
 * 计划里的 searchAfterExhausted 由模型给出也不能打开搜索。只有 reject 前缀的岗位被拒，其余入选。
 */
async function run(count: number, feed: Feed, opts: { allowSearch?: boolean; modelSaysSearch?: boolean } = {}) {
  const message = `深圳Python${count}个，月薪至少20K，先存草稿`;
  const plan = { city: '深圳', salaryMinK: 20, criteria: 'Python，月薪至少20K', sendNow: false, quote: message, excludedCompanies: [], degreeLimit: null,
    ...(opts.modelSaysSearch ? { searchAfterExhausted: true } : {}), directions: [{ name: 'Python', keywords: ['Python'], count }] };
  const mock = await startMockModel(ruleModel(plan, jobId => jobId.startsWith('reject')
    ? { decision: 'reject', reason: '主要职责是销售', rejectionCategory: '岗位方向不符' }
    : { decision: 'select', reason: 'Python后端职责' }));
  const dir = tempDir('boss-recommend-exhaustion-');
  fs.mkdirSync(path.join(dir, 'codex-home'));
  fs.writeFileSync(path.join(dir, 'codex-home', 'config.toml'), mockProviderToml(mock.baseUrl, 'gpt-mock'));
  const events: string[] = [];
  const forbidden = async (): Promise<never> => { throw new Error('只找不投不能联系'); };
  const site: FakeSite = {
    open: async () => ({ page: 'ready', url: null }), status: async () => ({ page: 'ready', url: null }), close: async () => {},
    recommend: async q => { events.push(`recommend:${q.page}`); return feed.recommend(q.page); },
    search: async q => { events.push(`search:${q.page}`); return feed.search?.(q.page) ?? page([], true); },
    jobDetail: async c => { events.push(`detail:${c.jobId}`); return `实际JD-${c.jobId}`; },
    openJob: forbidden, contact: forbidden, readChat: forbidden, sendGreeting: forbidden,
  };
  const server = await startServer({ readClock: instantReadClock, dataDir: dir, port: 0, site: countedSite(site) });
  try {
    const requirements = [`推荐来源：${TAB}`, ...(opts.allowSearch ? ['推荐耗尽后搜索补充：允许'] : [])].join('\n');
    await api(server.url, 'PUT', '/api/inputs', { greeting: '您好', requirements, resume: { text: 'Python后端经验' } });
    await api(server.url, 'POST', '/api/chat', { message });
    const state = await new Promise<AppState>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); server.app.off('changed', check); };
      const check = () => void server.app.getState().then(s => { if (!s.chat.pending && s.discovery.status === 'idle') { cleanup(); resolve(s); } }, e => { cleanup(); reject(e); });
      const timer = setTimeout(() => { cleanup(); reject(new Error('发现未结束')); }, 20_000);
      server.app.on('changed', check); check();
    });
    return { state, events, details: events.filter(e => e.startsWith('detail:')).map(e => e.slice(7)), searched: events.some(e => e.startsWith('search:')) };
  } finally { await server.close(); mock.close(); }
}

test('站点仍有更多时，重复批不判定耗尽，继续读到明确结束；结束批的新岗位不漏读', async () => {
  const pages = [page(['a'], false), page(['a'], false), page(['b'], true)];
  const { details, events, state } = await run(5, { recommend: n => pages[n - 1] ?? page([], true) }, { allowSearch: true });
  assert.deepEqual(events.filter(e => e.startsWith('recommend:')), ['recommend:1', 'recommend:2', 'recommend:3']);
  assert.deepEqual(details.filter(id => !id.startsWith('s')), ['a', 'b']);
  assert.match(state.discovery.message!, /站点明确.*推荐结束/);
});

test('推荐加载失败（是否还有更多未知）不判定耗尽，已授权也不转搜索', async () => {
  const { searched, state } = await run(3, {
    recommend: n => { if (n === 2) throw new Error('职位分页加载等待超时'); return page(['a'], false); },
    search: () => page(['s1'], true),
  }, { allowSearch: true });
  assert.equal(searched, false);
  assert.match(state.discovery.message!, /加载失败/);
  assert.doesNotMatch(state.discovery.message!, /站点明确/);
});

test('连续多批没有新岗位但站点仍显示有更多时停止且不判定耗尽，已授权也不搜索', async () => {
  const { searched, events, state } = await run(3, { recommend: () => page(['a'], false), search: () => page(['s1'], true) }, { allowSearch: true });
  assert.equal(searched, false);
  assert.ok(events.filter(e => e.startsWith('recommend:')).length > 2, '重复批要继续读几批，不能第一次空批就停');
  assert.match(state.discovery.message!, /没有新岗位.*未判定/);
});

test('仅在要求授权且推荐明确用尽后搜索补足缺额，跨来源去重不重读', async () => {
  const { details, state, events } = await run(3, {
    recommend: () => page(['a', 'reject-x'], true),
    search: n => n === 1 ? page(['a', 'reject-x', 's1', 's2', 's3'], true) : page([], true),
  }, { allowSearch: true });
  assert.ok(events.indexOf('search:1') > events.indexOf('recommend:1'));
  assert.deepEqual(details, ['a', 'reject-x', 's1', 's2']);
  assert.deepEqual(state.batch!.targets.map(t => t.jobId), ['a', 's1', 's2']);
});

test('没有授权行时推荐明确用尽也只用指定标签，模型自行声明搜索也无效', async () => {
  const { searched, state } = await run(3, { recommend: () => page(['a'], true), search: () => page(['s1'], true) }, { modelSaysSearch: true });
  assert.equal(searched, false);
  assert.deepEqual(state.batch!.targets.map(t => t.jobId), ['a']);
  assert.match(state.discovery.message!, /站点明确.*推荐结束.*未搜索/);
});

test('搜索翻页遇到只有重复岗位但站点仍显示有更多的页，继续下一页，不当作关键词用尽', async () => {
  const { details } = await run(3, {
    recommend: () => page([], true),
    search: n => [page(['s1'], false), page(['s1'], false), page(['s2', 's3'], true)][n - 1] ?? page([], true),
  }, { allowSearch: true });
  assert.deepEqual(details, ['s1', 's2', 's3']);
});
