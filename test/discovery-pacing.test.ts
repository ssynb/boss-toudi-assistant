import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, type RunningServer } from '../src/server.ts';
import { openState } from '../src/state.ts';
import { SiteBlockedError, type Site } from '../src/boss.ts';
import type { AppState } from '../src/contracts.ts';
import { api, instantReadClock, tempDir } from './helpers.ts';
import { mockProviderToml, startMockModel, type MockItem } from './mock-responses.ts';

const message = '深圳Python，薪资不限，只找不投';
const end: MockItem[] = [{ type: 'message', text: '完成' }];
const action = (count: number): MockItem[] => [{ type: 'function_call', name: 'start_delivery', args: { city: '深圳', salaryMinK: null, criteria: 'Python', sendNow: false, quote: message, directions: [{ name: 'Python', keywords: ['Python'], count }] } }];
const verdicts = (ids: string[], selected: string[] = ids): MockItem[] => [{ type: 'function_call', name: 'submit_decisions', args: { decisions: ids.map(jobId => selected.includes(jobId)
  ? { jobId, decision: 'select', reason: '主要职责匹配Python经验', greeting: '您好，我有Python经验' }
  : { jobId, decision: 'reject', reason: '方向不符', rejectionCategory: '岗位方向不符' }) } }];
const job = (jobId: string) => ({ jobId, company: '测试公司', title: 'Python开发', salary: '20-40K', url: `https://www.zhipin.com/job_detail/${jobId}.html`, area: '深圳', snippet: '' });

async function fixture(script: MockItem[][], clock = instantReadClock) {
  const mock = await startMockModel(script);
  const dir = tempDir('boss-discovery-pacing-');
  fs.mkdirSync(path.join(dir, 'codex-home'));
  fs.writeFileSync(path.join(dir, 'codex-home', 'config.toml'), mockProviderToml(mock.baseUrl, 'gpt-mock'));
  const events: string[] = [];
  const writes: string[] = [];
  const forbidden = (name: string) => async (): Promise<never> => { writes.push(name); throw new Error('只找不投不能联系'); };
  const site: Site = {
    open: async () => ({ page: 'ready', url: null }), status: async () => ({ page: 'ready', url: null }), close: async () => {},
    search: async q => { events.push(`search:${q.page}`); return q.page === 1 ? [job('a')] : []; },
    jobDetail: async c => { events.push(`detail:${c.jobId}`); return '实际JD Python开发'; },
    openJob: forbidden('open'), contact: forbidden('contact'), readChat: forbidden('readChat'), sendGreeting: forbidden('greeting'),
  };
  const server = await startServer({ dataDir: dir, port: 0, site, readClock: clock });
  await api(server.url, 'PUT', '/api/inputs', { requirements: '', resume: { text: 'Python开发经验' } });
  return { mock, dir, server, site, events, writes };
}

function idle(server: RunningServer): Promise<AppState> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); server.app.off('changed', check); };
    const check = () => void server.app.getState().then(s => { if (!s.chat.pending && s.discovery.status === 'idle') { cleanup(); resolve(s); } }, e => { cleanup(); reject(e); });
    const timer = setTimeout(() => { cleanup(); reject(new Error('发现未结束')); }, 10_000);
    server.app.on('changed', check); check();
  });
}

test('搜索、翻页、重试及每个新JD之前随机等待1.5–3秒，结果说明节奏', async () => {
  let index = 0;
  const values = [0, 1 - Number.EPSILON, 0.5];
  const order: string[] = [];
  const clock = { random: () => values[index++ % values.length]!, async wait(ms: number, signal: AbortSignal) { signal.throwIfAborted(); order.push(`wait:${ms}`); } };
  const { mock, server, site, writes } = await fixture([action(2), end, verdicts(['a']), end, verdicts(['b']), end], clock);
  let failed = false;
  site.search = async q => { order.push(`search:${q.page}`); if (q.page === 2 && !failed) { failed = true; throw new Error('测试读取超时'); } return [job(q.page === 1 ? 'a' : 'b')]; };
  site.jobDetail = async card => { order.push(`detail:${card.jobId}`); return '实际JD Python开发'; };
  try {
    await api(server.url, 'POST', '/api/chat', { message });
    const state = await idle(server);
    assert.deepEqual(order, ['wait:1500', 'search:1', 'wait:3000', 'detail:a', 'wait:2250', 'search:2', 'wait:1500', 'search:2', 'wait:3000', 'detail:b']);
    assert.equal(state.batch!.targets.length, 2);
    assert.match(state.discovery.message!, /1\.5.*3.*秒/);
    assert.deepEqual(writes, []);
  } finally { await server.close(); mock.close(); }
});

test('等待下一页时停止会取消等待、不再搜索，并保存此前正常入选的草稿', async () => {
  let waits = 0;
  let entered!: () => void;
  const waiting = new Promise<void>(r => { entered = r; });
  const clock = { random: () => 0.5, async wait(_ms: number, signal: AbortSignal) {
    signal.throwIfAborted();
    if (++waits !== 3) return;
    entered();
    await new Promise<void>((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  } };
  const { mock, server, events, writes } = await fixture([action(2), end, verdicts(['a']), end], clock);
  try {
    await api(server.url, 'POST', '/api/chat', { message });
    await Promise.race([waiting, idle(server).then(() => { throw new Error('应等待下一次读取，而不是立即结束'); })]);
    await api(server.url, 'POST', '/api/discovery/stop');
    const state = await idle(server);
    assert.deepEqual(events, ['search:1', 'detail:a']);
    assert.equal(state.batch!.status, 'draft');
    assert.deepEqual(state.batch!.targets.map(target => target.jobId), ['a']);
    assert.match(state.discovery.message!, /停止|提前结束/);
    assert.deepEqual(writes, []);
  } finally { await server.close(); mock.close(); }
});

test('复现124份JD入选13个后安全验证：13个全部保存，重启保留且零联系', async () => {
  const ids = Array.from({ length: 124 }, (_, i) => `j${i}`);
  const script: MockItem[][] = [action(100), end];
  for (let i = 0; i < ids.length; i += 10) script.push(verdicts(ids.slice(i, i + 10), [ids[i]!]), end);
  const { mock, dir, server, site, events, writes } = await fixture(script);
  let closed = false;
  site.search = async q => { if (q.page === 2) throw new SiteBlockedError({ page: 'verify', url: null }); return ids.map(job); };
  try {
    await api(server.url, 'POST', '/api/chat', { message });
    const state = await idle(server);
    assert.equal(events.filter(event => event.startsWith('detail:')).length, 124);
    assert.equal(state.batch!.targets.length, 13);
    assert.equal(state.batch!.status, 'draft');
    assert.deepEqual(state.batch!.targets.map(target => target.jobId), ['j0', 'j10', 'j20', 'j30', 'j40', 'j50', 'j60', 'j70', 'j80', 'j90', 'j100', 'j110', 'j120']);
    assert.match(state.discovery.message!, /提前结束.*验证/);
    assert.match(state.discovery.message!, /实际 13/);
    assert.deepEqual(writes, []);
    await server.close(); closed = true;
    const recovered = openState(path.join(dir, 'state.sqlite'));
    assert.deepEqual(recovered.snapshot().batch, state.batch);
    recovered.close();
  } finally { if (!closed) await server.close(); mock.close(); }
});
