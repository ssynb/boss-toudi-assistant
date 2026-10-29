import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/server.ts';
import { openState } from '../src/state.ts';
import type { AppState } from '../src/contracts.ts';
import type { Site } from '../src/boss.ts';
import { api, countedSite, instantReadClock, tempDir } from './helpers.ts';
import { startMockModel, mockProviderToml, type MockItem } from './mock-responses.ts';

const greeting = '您好，希望了解这个岗位。';
const job = (jobId: string) => ({ jobId, title: 'AI应用开发', company: '测试公司', salary: '20-40K', area: '深圳', snippet: '', url: `https://www.zhipin.com/job_detail/${jobId}.html` });
const end: MockItem[] = [{ type: 'message', text: '完成' }];
const call = (name: string, args: unknown): MockItem[] => [{ type: 'function_call', name, args }];
const message = '深圳AI开发，薪资不限，不要猎头，找2个';
const plan = (sendNow: boolean) => call('start_delivery', { city: '深圳', salaryMinK: null, criteria: 'AI开发大类，不要猎头', sendNow, quote: message, directions: [{ name: 'AI开发', keywords: ['AI开发'], count: 2 }] });
const choose = (jobId: string) => call('submit_decisions', { decisions: [{ jobId, decision: 'select', reason: '主要职责属于AI应用开发' }] });

/** 服务停止期间运维先授权当日额度，再启动服务。 */
async function setup(script: MockItem[][], used: number, limit: number) {
  const mock = await startMockModel(script);
  const dir = tempDir('boss-read-grant-');
  fs.mkdirSync(path.join(dir, 'codex-home'));
  fs.writeFileSync(path.join(dir, 'codex-home', 'config.toml'), mockProviderToml(mock.baseUrl, 'gpt-mock'));
  const state = openState(path.join(dir, 'state.sqlite'));
  try {
    state.saveInputs({ requirements: '深圳AI开发', greeting, resume: { text: 'Python经验' } });
    state.grantJobReadLimit(limit);
    for (let i = 0; i < used; i++) state.recordJobRead();
  } catch (error) { mock.close(); throw error; }
  finally { state.close(); }
  const calls: string[] = [];
  const texts: string[] = [];
  const site: Site = {
    open: async () => ({ page: 'ready', url: null }), status: async () => ({ page: 'ready', url: null }), close: async () => {},
    search: async q => q.page === 1 ? [job('a'), job('b')] : [],
    jobDetail: async c => { calls.push(`detail:${c.jobId}`); return '主要职责：AI应用开发'; },
    openJob: async t => { calls.push(`open:${t.jobId}`); return { kind: 'canContact', evidence: '' }; },
    contact: async t => { calls.push(`contact:${t.jobId}`); return { ok: true, evidence: '', identity: { jobId: t.jobId, recruiterUrl: `https://www.zhipin.com/boss_detail/${t.jobId}.html` } }; },
    readChat: async () => ({ ourMessages: 0, evidence: '' }),
    sendGreeting: async (_t, text) => { texts.push(text); return { ok: true, evidence: '已送达' }; },
  };
  const server = await startServer({ dataDir: dir, port: 0, site: countedSite(site), readClock: instantReadClock });
  const idle = () => new Promise<AppState>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); server.app.off('changed', check); };
    const check = () => void server.app.getState().then(s => { if (!s.chat.pending && s.discovery.status === 'idle' && s.batch?.status !== 'running') { cleanup(); resolve(s); } }, e => { cleanup(); reject(e); });
    const timer = setTimeout(() => { cleanup(); reject(new Error('任务未结束')); }, 10_000);
    server.app.on('changed', check); check();
  });
  return { mock, server, calls, texts, idle };
}

function userContext(mock: { requests: { input: unknown[] }[] }, index: number): Record<string, unknown> {
  const user = mock.requests[index]!.input.filter(item => (item as { role?: string }).role === 'user').at(-1) as { content: { text: string }[] };
  return JSON.parse(user.content[0]!.text);
}

test('北京时间当日授权500：已读300不清零，重启保留，第501次拒绝，次日恢复默认300', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-27T17:00:00Z') });
  const file = path.join(tempDir('boss-read-grant-day-'), 'state.sqlite');
  let state = openState(file);
  try {
    for (let i = 0; i < 300; i++) state.recordJobRead();
    assert.throws(() => state.recordJobRead(), /今日浏览上限/);
    state.grantJobReadLimit(500);
    assert.deepEqual([state.snapshot().jobReadsToday, state.snapshot().dailyJobReadLimit], [300, 500]);
    state.close(); state = openState(file);
    t.mock.timers.setTime(new Date('2026-10-28T02:00:00Z').getTime());
    assert.deepEqual([state.snapshot().jobReadsToday, state.snapshot().dailyJobReadLimit], [300, 500]);
    for (let i = 0; i < 200; i++) state.recordJobRead();
    assert.throws(() => state.recordJobRead(), /今日浏览上限/);
    assert.equal(state.snapshot().jobReadsToday, 500);
    t.mock.timers.setTime(new Date('2026-10-28T16:00:00Z').getTime());
    assert.deepEqual([state.snapshot().jobReadsToday, state.snapshot().dailyJobReadLimit], [0, 300]);
    for (let i = 0; i < 300; i++) state.recordJobRead();
    assert.throws(() => state.recordJobRead(), /今日浏览上限/);
  } finally { state.close(); t.mock.timers.reset(); }
});

test('有任务进行时或额度不是不低于默认值的整数时拒绝授权，原额度不变', () => {
  const state = openState(path.join(tempDir('boss-read-grant-busy-'), 'state.sqlite'));
  try {
    for (const invalid of [299, 500.5]) assert.throws(() => state.grantJobReadLimit(invalid), /额度/);
    state.beginChat('今天能投多少');
    assert.throws(() => state.grantJobReadLimit(500), /运行/);
    assert.equal(state.snapshot().dailyJobReadLimit, 300);
  } finally { state.close(); }
});

test('授权500后已读300仍可开始找岗投递，顾问与应用状态使用实际上限', async () => {
  const { mock, server, calls, texts, idle } = await setup([plan(true), end, choose('a'), end, choose('b'), end], 300, 500);
  try {
    await api(server.url, 'POST', '/api/chat', { message });
    const state = await idle();
    assert.equal(userContext(mock, 0).dailyJobReadLimit, 500);
    assert.deepEqual([state.jobReadsToday, state.dailyJobReadLimit], [302, 500]);
    assert.deepEqual(calls, ['detail:a', 'open:a', 'contact:a', 'detail:b', 'open:b', 'contact:b']);
    assert.deepEqual(texts, [greeting, greeting]);
  } finally { try { await server.close(); } finally { mock.close(); } }
});

test('授权上限用尽时停止，保留已选且不再打开或联系', async () => {
  const { mock, server, calls, texts, idle } = await setup([plan(true), end, choose('a'), end, choose('b'), end], 498, 500);
  try {
    await api(server.url, 'POST', '/api/chat', { message });
    const state = await idle();
    assert.equal(state.jobReadsToday, 500);
    assert.equal(state.batch!.status, 'paused');
    assert.match(state.chat.messages.map(m => m.text).join('\n'), /今日浏览上限已到，明天继续/);
    assert.deepEqual(calls, ['detail:a', 'open:a', 'contact:a', 'detail:b']);
    assert.deepEqual(texts, [greeting]);
    assert.equal(state.batch!.targets[1]!.steps.contact, 'todo');
  } finally { try { await server.close(); } finally { mock.close(); } }
});

test('JD判定只按匿名公司或明确猎头标识排除猎头，缺少直招证明不是拒绝理由', async () => {
  const { mock, server, idle } = await setup([plan(false), end, call('submit_decisions', { decisions: ['a', 'b'].map(jobId => ({ jobId, decision: 'select', reason: '方向匹配' })) }), end], 0, 300);
  try {
    await api(server.url, 'POST', '/api/chat', { message });
    await idle();
    const judgment = JSON.stringify(mock.requests[2]);
    assert.match(judgment, /匿名公司/);
    assert.match(judgment, /缺少直招[^。]*不能/);
  } finally { try { await server.close(); } finally { mock.close(); } }
});
