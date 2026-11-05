import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/server.ts';
import { openState } from '../src/state.ts';
import { readSearchPlan } from '../src/search-plan.ts';
import type { JobCard, Site } from '../src/boss.ts';
import type { AppState } from '../src/contracts.ts';
import { countedSite, instantReadClock, tempDir, api } from './helpers.ts';
import { mockProviderToml, ruleModel, startMockModel } from './mock-responses.ts';

const REQUIREMENTS = '只找深圳。不要猎头。软通动力、isoftstone一律不投。岗位卡片明确要求硕士及以上的不要投，硕士优先不排除。';
const DEGREE_QUOTE = '岗位卡片明确要求硕士及以上的不要投';
const card = (jobId: string, patch: Partial<JobCard> = {}): JobCard => ({ jobId, title: '后端开发', company: `${jobId}科技`, salary: '20-40K', area: '深圳·南山区', snippet: '', url: `https://www.zhipin.com/job_detail/${jobId}.html`, degree: '本科', ...patch });

type Feed = { recommend?: (page: number) => JobCard[]; search?: (keyword: string, page: number) => JobCard[] };
type Direction = { name: string; count: number };

async function run(directions: Direction[], feed: Feed, selects: (jobId: string) => boolean, usedReads = 0) {
  const message = `深圳，月薪至少20K，不要猎头，${directions.map(d => `${d.name}${d.count}个`).join('、')}，先存草稿`;
  const plan = { city: '深圳', salaryMinK: 20, criteria: '月薪至少20K', sendNow: false, quote: message, excludedCompanies: ['软通动力', 'isoftstone'], degreeLimit: { from: '硕士', quote: DEGREE_QUOTE }, directions: directions.map(d => ({ ...d, keywords: [d.name] })) };
  const mock = await startMockModel(ruleModel(plan, jobId => selects(jobId)
    ? { decision: 'select', reason: '主要职责属于计划方向' }
    : { decision: 'reject', reason: '主要职责是销售', rejectionCategory: '岗位方向不符' }));
  const dir = tempDir('boss-card-prefilter-');
  fs.mkdirSync(path.join(dir, 'codex-home'));
  fs.writeFileSync(path.join(dir, 'codex-home', 'config.toml'), mockProviderToml(mock.baseUrl, 'gpt-mock'));
  const db = openState(path.join(dir, 'state.sqlite'));
  db.saveInputs({ greeting: '您好', requirements: REQUIREMENTS, resume: { text: '后端开发经验' } });
  for (let i = 0; i < usedReads; i++) db.recordJobRead();
  db.close();
  const events: string[] = [];
  const logs: string[] = [];
  const forbidden = async (): Promise<never> => { throw new Error('只找不投不能联系'); };
  const site: Site = {
    open: async () => ({ page: 'ready', url: null }), status: async () => ({ page: 'ready', url: null }), close: async () => {},
    recommend: async q => { events.push(`recommend:${q.page}`); return feed.recommend?.(q.page) ?? []; },
    search: async q => { events.push(`search:${q.keyword}:${q.page}`); return feed.search?.(q.keyword, q.page) ?? []; },
    jobDetail: async c => { events.push(`detail:${c.jobId}`); return `实际JD-${c.jobId}`; },
    openJob: forbidden, contact: forbidden, readChat: forbidden, sendGreeting: forbidden,
  };
  const server = await startServer({ readClock: instantReadClock, dataDir: dir, port: 0, site: countedSite(site) });
  server.app.on('log', (event: { text: string }) => logs.push(event.text));
  try {
    await api(server.url, 'POST', '/api/chat', { message });
    const state = await new Promise<AppState>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); server.app.off('changed', check); };
      const check = () => void server.app.getState().then(s => { if (!s.chat.pending && s.discovery.status === 'idle') { cleanup(); resolve(s); } }, e => { cleanup(); reject(e); });
      const timer = setTimeout(() => { cleanup(); reject(new Error('发现未结束')); }, 30_000);
      server.app.on('changed', check); check();
    });
    return { state, events, logs, details: events.filter(e => e.startsWith('detail:')).map(e => e.slice('detail:'.length)) };
  } finally { await server.close(); mock.close(); }
}

test('推荐与搜索共用卡片预筛：硕士/博士要求、黑名单公司、匿名雇主与猎头标识不打开详情，本科/不限/未知/硕士优先照常读取', async () => {
  const allowed = [card('ok-bachelor'), card('ok-unknown', { degree: undefined }), card('ok-any', { degree: '学历不限' }),
    card('ok-prefer', { title: '后端开发（硕士优先）' }), card('ok-near', { company: '软通智慧' })];
  const filtered = [card('master', { degree: '硕士' }), card('phd', { degree: '博士' }), card('brand', { company: '软通动力信息技术' }),
    card('brand-en', { company: 'iSoftStone' }), card('anon', { company: '某大型互联网公司', anonymous: true }), card('hunter', { markers: ['猎头'] })];
  const { state, details, logs } = await run([{ name: '后端', count: 6 }], {
    recommend: page => page === 1 ? [...filtered.slice(0, 3), ...allowed, ...filtered.slice(3)] : [],
    search: (_keyword, page) => page === 1 ? [card('s-master', { degree: '硕士' }), card('s-ok')] : [],
  }, () => true);
  assert.deepEqual(details, [...allowed.map(c => c.jobId), 's-ok']);
  assert.equal(state.jobReadsToday, 6, '卡片预筛不消耗详情读数');
  assert.deepEqual(state.batch!.targets.map(t => t.jobId), details);
  assert.match(state.discovery.message!, /推荐页.*卡片预筛排除 6 个/);
  assert.match(state.discovery.message!, /后端.*卡片预筛排除 1 个/);
  for (const [company, evidence] of [['master科技', '硕士'], ['phd科技', '博士'], ['软通动力信息技术', '软通动力'], ['iSoftStone', 'isoftstone'], ['某大型互联网公司', '匿名'], ['hunter科技', '猎头'], ['s-master科技', '硕士']]) {
    assert.ok(logs.some(text => text.includes('预筛') && text.includes(company!) && text.includes(evidence!)), `${company} 的预筛日志须带卡片字段与依据：${evidence}`);
  }
});

test('推荐连续低入选立即转搜索，不先吃满推荐半数预算', async () => {
  let n = 0;
  const { events, details, state } = await run([{ name: '后端', count: 20 }], {
    recommend: page => page <= 6 ? Array.from({ length: 15 }, () => card(`rec${n++}`)) : [],
    search: (_keyword, page) => page === 1 ? Array.from({ length: 20 }, (_, i) => card(`s${i}`)) : [],
  }, jobId => jobId.startsWith('s'));
  const recommended = details.filter(id => id.startsWith('rec'));
  assert.equal(recommended.length, 10, '连续10份推荐JD没有入选即停止推荐');
  assert.ok(events.includes('search:后端:1'));
  assert.equal(state.batch!.targets.length, 20);
  assert.match(state.discovery.message!, /推荐页.*连续 10 份.*未入选/);
});

test('方向预算先小额探索，再按实际入选效果把剩余额度给高产方向', async () => {
  const pages = (prefix: string) => (_keyword: string, page: number) => page <= 3 ? Array.from({ length: 10 }, (_, i) => card(`${prefix}${(page - 1) * 10 + i}`)) : [];
  // 当日只剩30份：固定按配额分会是低产20份、高产10份（高产只能入选5个）。
  const { state, details } = await run([{ name: '低产', count: 20 }, { name: '高产', count: 10 }], {
    search: (keyword, page) => pages(keyword === '低产' ? 'a' : 'b')(keyword, page),
  }, jobId => jobId.startsWith('b') && Number(jobId.slice(1)) % 2 === 0, 270);
  assert.equal(details.length, 30);
  assert.ok(details.slice(0, 6).every(id => id.startsWith('a')), '低产方向先获得小额探索');
  assert.deepEqual(state.discovery.directions.map(d => [d.name, d.selected]), [['低产', 0], ['高产', 10]], '剩余额度按实际入选效果给高产方向');
  assert.equal(details.filter(id => id.startsWith('a')).length, 10, '高产方向满额后余量回到低产方向');
});

test('卡片规则只接受用户原文中的公司与学历限制', () => {
  const latest = '深圳后端10个，薪资不限，开始';
  const base = { city: '深圳', salaryMinK: null, criteria: '后端', sendNow: false, quote: '开始', directions: [{ name: '后端', keywords: ['后端'], count: 10 }] };
  const sources = [REQUIREMENTS];
  const ok = readSearchPlan({ ...base, excludedCompanies: ['软通动力', 'ISOFTSTONE'], degreeLimit: { from: '硕士', quote: DEGREE_QUOTE } }, latest, 0, ['薪资不限'], sources);
  assert.deepEqual([ok.excludedCompanies, ok.degreeLimit], [['软通动力', 'ISOFTSTONE'], { from: '硕士', quote: DEGREE_QUOTE }]);
  for (const patch of [
    { excludedCompanies: ['腾讯'] }, { excludedCompanies: [''] },
    { degreeLimit: { from: '硕士', quote: '硕士优先不排除' } }, { degreeLimit: { from: '硕士', quote: '编造的不要硕士' } },
    { degreeLimit: { from: '本科', quote: DEGREE_QUOTE } },
  ]) assert.throws(() => readSearchPlan({ ...base, ...patch }, latest, 0, ['薪资不限'], sources), JSON.stringify(patch));
});
