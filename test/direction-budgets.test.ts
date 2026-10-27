import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/server.ts';
import type { Site } from '../src/boss.ts';
import type { AppState } from '../src/contracts.ts';
import { countedSite, instantReadClock, tempDir, api } from './helpers.ts';
import { mockProviderToml, startMockModel, type MockItem } from './mock-responses.ts';

const end: MockItem[] = [{ type: 'message', text: '完成' }];
const select = (jobId: string) => ({ jobId, decision: 'select', reason: '主要职责匹配Python经验' });
const reject = (jobId: string, rejectionCategory: string) => ({ jobId, decision: 'reject', reason: `私有拒绝说明-${jobId}`, rejectionCategory, ...(rejectionCategory === '用户明确条件' ? { requirementQuote: '必须有Python项目' } : {}) });

async function run(directions: { name: string; count: number }[], cards: Record<string, string[]>, decisions: object[][]) {
  const message = `深圳，月薪至少20K，${directions.map(d => `${d.name}${d.count}个`).join('、')}，必须有Python项目，先存草稿`;
  const script: MockItem[][] = [
    [{ type: 'function_call', name: 'start_delivery', args: { city: '深圳', salaryMinK: 20, criteria: 'Python，月薪至少20K，不要猎头和外包', sendNow: false, quote: message, directions: directions.map(d => ({ ...d, keywords: [d.name] })) } }], end,
    ...decisions.flatMap(items => [[{ type: 'function_call' as const, name: 'submit_decisions', args: { decisions: items } }], end]),
  ];
  const model = await startMockModel(script);
  const dir = tempDir('boss-direction-budget-');
  fs.mkdirSync(path.join(dir, 'codex-home'));
  fs.writeFileSync(path.join(dir, 'codex-home', 'config.toml'), mockProviderToml(model.baseUrl, 'gpt-mock'));
  const searches: string[] = [];
  const reads: string[] = [];
  const forbidden = async (): Promise<never> => { throw new Error('只找不投不能联系'); };
  const site: Site = {
    open: async () => ({ page: 'ready', url: null }), status: async () => ({ page: 'ready', url: null }), close: async () => {},
    search: async q => { searches.push(q.keyword); return (q.page === 1 ? cards[q.keyword] ?? [] : []).map(jobId => ({ jobId, title: '工程师', company: '测试公司', salary: '20-40K', area: '深圳', snippet: '', url: `https://www.zhipin.com/job_detail/${jobId}.html` })); },
    jobDetail: async c => { reads.push(c.jobId); return `实际JD-${c.jobId}：主要职责Python开发，了解前端工具加分`; },
    openJob: forbidden, contact: forbidden, readChat: forbidden, sendGreeting: forbidden,
  };
  const server = await startServer({ readClock: instantReadClock, dataDir: dir, port: 0, site: countedSite(site) });
  try {
    await api(server.url, 'PUT', '/api/inputs', { greeting: '您好，我有五年 React 经验', requirements: '', resume: { text: 'Python后端开发经验' } });
    await api(server.url, 'POST', '/api/chat', { message });
    const state = await new Promise<AppState>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); server.app.off('changed', check); };
      const check = () => void server.app.getState().then(s => { if (!s.chat.pending && s.discovery.status === 'idle') { cleanup(); resolve(s); } }, e => { cleanup(); reject(e); });
      const timer = setTimeout(() => { cleanup(); reject(new Error('发现未结束')); }, 10_000);
      server.app.on('changed', check); check();
    });
    return { state, reads, searches, requests: model.requests };
  } finally { await server.close(); model.close(); }
}

test('第一方向拒绝率高不能消耗后续预算；拒绝原因按方向分类计数而不保存全文', async () => {
  const categories = ['城市不符', '薪资不足', '外包/猎头/中介', '用户明确条件', '岗位方向不符', '岗位方向不符'];
  const rounds = categories.map((category, i) => [reject(`a${i * 2}`, category), reject(`a${i * 2 + 1}`, category)]);
  const { state, reads, searches } = await run([{ name: 'AI开发', count: 2 }, { name: '后端', count: 1 }],
    { AI开发: Array.from({ length: 20 }, (_, i) => `a${i}`), 后端: ['b'] }, [...rounds, [select('b')]]);
  assert.deepEqual(reads, [...Array.from({ length: 12 }, (_, i) => `a${i}`), 'b']);
  assert.deepEqual(searches, ['AI开发', '后端']);
  assert.deepEqual(state.batch!.targets.map(t => t.jobId), ['b']);
  assert.match(state.discovery.message!, /AI开发.*读取 12\/12.*入选 0\/2.*预算/);
  assert.match(state.discovery.message!, /后端.*读取 1\/6.*入选 1\/1.*配额/);
  for (const category of ['城市不符', '薪资不足', '外包/猎头/中介', '用户明确条件']) assert.ok(state.discovery.message!.includes(`${category} 2`), category);
  assert.ok(state.discovery.message!.includes('岗位方向不符 4'));
  assert.ok(!JSON.stringify(state).includes('私有拒绝说明'), '持久状态只保存拒绝类别计数，不存reject理由全文');
});

test('前一方向未用完预算可顺延，但仍保留第三方向自己的读取份额', async () => {
  const bad = Array.from({ length: 17 }, (_, i) => [reject(`b${i}`, '岗位方向不符')]);
  const { state, reads, searches } = await run([{ name: '第一', count: 2 }, { name: '第二', count: 1 }, { name: '第三', count: 1 }],
    { 第一: ['a'], 第二: Array.from({ length: 30 }, (_, i) => `b${i}`), 第三: ['c'] }, [[select('a')], ...bad, [select('c')]]);
  assert.deepEqual(reads, ['a', ...Array.from({ length: 17 }, (_, i) => `b${i}`), 'c']);
  assert.deepEqual(searches, ['第一', '第一', '第二', '第三']);
  assert.deepEqual(state.batch!.targets.map(t => t.jobId), ['a', 'c']);
  assert.match(state.discovery.message!, /第一.*读取 1\/12.*入选 1\/2.*范围/);
  assert.match(state.discovery.message!, /第二.*读取 17\/17.*入选 0\/1.*预算/);
  assert.match(state.discovery.message!, /第三.*读取 1\/6.*入选 1\/1.*配额/);
  assert.match(state.discovery.message!, /岗位方向不符 17/);
});

test('reject缺少合法归类时须重试判定，不能静默丢弃原因', async () => {
  const { state, reads, requests } = await run([{ name: 'AI', count: 1 }], { AI: ['a'] },
    [[{ jobId: 'a', decision: 'reject', reason: '私有拒绝说明-a' }], [reject('a', '薪资不足')]]);
  assert.deepEqual(reads, ['a']);
  assert.match(JSON.stringify(requests[3]?.input.at(-1)), /类别|分类/);
  assert.match(state.discovery.message!, /薪资不足 1/);
});
