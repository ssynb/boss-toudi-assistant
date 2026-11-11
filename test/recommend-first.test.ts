import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/server.ts';
import { SiteBlockedError, type JobCard, type Site } from '../src/boss.ts';
import type { AppState } from '../src/contracts.ts';
import { countedSite, instantReadClock, tempDir, api , type FakeSite } from './helpers.ts';
import { mockProviderToml, startMockModel, type MockItem } from './mock-responses.ts';

const end: MockItem[] = [{ type: 'message', text: '完成' }];
const select = (jobId: string, direction?: string) => ({ jobId, decision: 'select', reason: '主要职责属于计划方向', ...(direction ? { direction } : {}) });
const reject = (jobId: string) => ({ jobId, decision: 'reject', reason: '主要职责是销售', rejectionCategory: '岗位方向不符' });
const judged = (...items: object[]): MockItem[][] => [[{ type: 'function_call', name: 'submit_decisions', args: { decisions: items } }], end];
const card = (jobId: string, area = '深圳·南山区', salary = '20-40K'): JobCard => ({ jobId, area, salary, title: '工程师', company: '测试公司', snippet: '', url: `https://www.zhipin.com/job_detail/${jobId}.html` });

type Feed = { recommend: (page: number) => Promise<JobCard[]>; search?: (page: number) => Promise<JobCard[]>; detail?: (jobId: string) => Promise<string> };

async function run(directions: { name: string; count: number }[], feed: Feed, decisions: MockItem[][], recommendationTab?: string) {
  const message = `深圳，月薪至少20K，${directions.map(d => `${d.name}${d.count}个`).join('、')}，先存草稿`;
  const model = await startMockModel([
    [{ type: 'function_call', name: 'start_delivery', args: { city: '深圳', salaryMinK: 20, criteria: '月薪至少20K', sendNow: false, quote: message, directions: directions.map(d => ({ ...d, keywords: [d.name] })) } }], end,
    ...decisions,
  ]);
  const dir = tempDir('boss-recommend-first-');
  fs.mkdirSync(path.join(dir, 'codex-home'));
  fs.writeFileSync(path.join(dir, 'codex-home', 'config.toml'), mockProviderToml(model.baseUrl, 'gpt-mock'));
  const events: string[] = [];
  const cities = new Set<string>();
  const forbidden = async (): Promise<never> => { throw new Error('只找不投不能联系'); };
  const site: FakeSite = {
    open: async () => ({ page: 'ready', url: null }), status: async () => ({ page: 'ready', url: null }), close: async () => {},
    recommend: async q => { events.push(`recommend:${q.page}`); if (q.tab) events.push(`tab:${q.tab}`); cities.add(q.city); return feed.recommend(q.page); },
    search: async q => { events.push(`search:${q.keyword}:${q.page}`); return feed.search?.(q.page) ?? []; },
    jobDetail: async c => { events.push(`detail:${c.jobId}`); return feed.detail ? feed.detail(c.jobId) : `实际JD-${c.jobId}`; },
    openJob: forbidden, contact: forbidden, readChat: forbidden, sendGreeting: forbidden,
  };
  const server = await startServer({ readClock: instantReadClock, dataDir: dir, port: 0, site: countedSite(site) });
  try {
    await api(server.url, 'PUT', '/api/inputs', { greeting: '您好', requirements: recommendationTab ? `推荐来源：${recommendationTab}` : '', resume: { text: 'AI与后端开发经验' } });
    await api(server.url, 'POST', '/api/chat', { message });
    const state = await new Promise<AppState>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); server.app.off('changed', check); };
      const check = () => void server.app.getState().then(s => { if (!s.chat.pending && s.discovery.status === 'idle') { cleanup(); resolve(s); } }, e => { cleanup(); reject(e); });
      const timer = setTimeout(() => { cleanup(); reject(new Error('发现未结束')); }, 20_000);
      server.app.on('changed', check); check();
    });
    return { state, events, cities };
  } finally { await server.close(); model.close(); }
}

test('先遍历推荐页再读JD；推荐满足各方向配额时不搜索，异地与低薪卡片不打开详情', async () => {
  const pages = [[card('r1'), card('far', '北京·朝阳区'), card('low', '深圳', '10-15K'), card('r2', '深圳')], [card('r1')]];
  const { state, events, cities } = await run([{ name: 'AI开发', count: 1 }, { name: '后端', count: 1 }],
    { recommend: async page => pages[page - 1] ?? [] }, judged(select('r1', 'AI开发'), select('r2', '后端')));
  assert.deepEqual(events, ['recommend:1', 'recommend:2', 'detail:r1', 'detail:r2'], '推荐流只遍历一次且去重，读完卡片后才打开详情');
  assert.deepEqual(state.batch!.targets.map(t => t.jobId), ['r1', 'r2']);
  assert.deepEqual([...cities], ['深圳'], '推荐页按计划城市打开，仍逐卡核对地区');
  assert.deepEqual(state.discovery.directions.map(d => [d.name, d.selected]), [['AI开发', 1], ['后端', 1]]);
  assert.equal(state.jobReadsToday, 2, '卡片过滤不占详情额度');
});

test('推荐流始终还有更多时限量读取，剩余预算按方向搜索补足，跨来源已判定岗位不重读', async () => {
  const recommendIds = Array.from({ length: 10 }, (_, i) => `rec${i}`);
  const decisions = [...judged(select('rec0'), reject('rec1')), ...['rec2', 'rec3', 'rec4', 'rec5'].flatMap(id => judged(reject(id))), ...judged(select('s1'))];
  const { state, events } = await run([{ name: 'AI开发', count: 2 }], {
    recommend: async page => recommendIds.map(id => card(page === 1 ? id : `${id}-${page}`)),
    search: async page => page === 1 ? [card('rec0'), card('rec1'), card('s1')] : [],
  }, decisions);
  const details = events.filter(event => event.startsWith('detail:'));
  assert.deepEqual(details, ['rec0', 'rec1', 'rec2', 'rec3', 'rec4', 'rec5', 's1'].map(id => `detail:${id}`), '推荐只用一部分预算，同一JD不重读');
  assert.equal(events.filter(event => event.startsWith('recommend:')).length, 1, '已收集足够推荐卡片后不再滚动');
  assert.ok(events.indexOf('search:AI开发:1') > events.indexOf('detail:rec5'), '推荐不足才搜索补充');
  assert.deepEqual(state.batch!.targets.map(t => t.jobId), ['rec0', 's1']);
  assert.match(state.discovery.message!, /推荐/);
});

test('推荐阶段遇到安全验证立即停止，不转搜索，保留已正常判定的入选', async () => {
  const { state, events } = await run([{ name: 'AI开发', count: 2 }], {
    recommend: async page => page === 1 ? [card('a'), card('x'), card('b')] : [],
    detail: async jobId => { if (jobId === 'b') throw new SiteBlockedError({ page: 'verify', url: null }); return `实际JD-${jobId}`; },
  }, judged(select('a'), reject('x')));
  assert.ok(!events.some(event => event.startsWith('search:')), '验证不是推荐不足，不能转去搜索');
  assert.deepEqual(events.filter(event => event.startsWith('detail:')), ['detail:a', 'detail:x', 'detail:b']);
  assert.equal(state.batch!.status, 'draft');
  assert.deepEqual(state.batch!.targets.map(t => t.jobId), ['a']);
  assert.match(state.discovery.message!, /验证/);
});

test('指定求职方向标签时只读取该推荐流，不足也不转搜索', async () => {
  const { state, events } = await run([{ name: 'AI开发', count: 2 }], {
    recommend: async page => page === 1 ? [card('python1')] : [],
    search: async () => [card('must-not-search')],
  }, judged(select('python1')), 'Python(深圳)');
  assert.deepEqual(events.filter(event => event.startsWith('tab:')), ['tab:Python(深圳)', 'tab:Python(深圳)']);
  assert.ok(!events.some(event => event.startsWith('search:')));
  assert.deepEqual(state.batch!.targets.map(target => target.jobId), ['python1']);
  assert.match(state.discovery.message!, /Python\(深圳\)/);
});
