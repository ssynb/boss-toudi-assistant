import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/server.ts';
import { openState } from '../src/state.ts';
import { Executor, type WriteSite } from '../src/executor.ts';
import { requireQuota } from '../src/search-plan.ts';
import type { Site } from '../src/boss.ts';
import type { AppState } from '../src/contracts.ts';
import { api, tempDir } from './helpers.ts';
import { mockProviderToml, startMockModel, type MockItem } from './mock-responses.ts';

const end: MockItem[] = [{ type: 'message', text: '完成' }];
const call = (name: string, args: unknown): MockItem[] => [{ type: 'function_call', name, args }];
const message = '在北京找AI开发2个、后端1个，薪资不限，先存草稿';
const plan = { city: '北京', salaryMinK: null, criteria: 'Python和Agent经验匹配', sendNow: false, quote: message,
  directions: [{ name: 'AI开发', keywords: ['Agent'], count: 2 }, { name: '后端', keywords: ['Python'], count: 1 }] };
const job = (jobId: string) => ({ jobId, title: '工程师', company: `公司${jobId}`, salary: '20-40K', url: `https://www.zhipin.com/job_detail/${jobId}.html`, area: '北京', snippet: '' });
const decisions = (...ids: string[]) => call('submit_decisions', { decisions: ids.map(jobId => ({ jobId, decision: 'select', reason: '实际JD匹配Python', greeting: '您好，我有Python经验' })) });

async function setup(script: MockItem[][], contacted = 0) {
  const mock = await startMockModel(script);
  const dir = tempDir('boss-chat-tasks-');
  fs.mkdirSync(path.join(dir, 'codex-home'));
  fs.writeFileSync(path.join(dir, 'codex-home', 'config.toml'), mockProviderToml(mock.baseUrl, 'gpt-mock'));
  const db = openState(path.join(dir, 'state.sqlite'));
  db.saveInputs({ requirements: '', resume: { text: 'Python后端和Agent经验' } });
  if (contacted) {
    const batch = db.replaceBatch(Array.from({ length: contacted }, (_, i) => ({ ...job(`old${i}`), reason: '旧记录', greeting: '您好' })));
    batch.targets.forEach(t => db.setStep(t, 'contact', 'done', '测试账本'));
  }
  db.close();
  const searches: string[] = [];
  const writes: string[] = [];
  const site: Site = {
    open: async () => ({ page: 'ready', url: null }), close: async () => {}, status: async () => ({ page: 'ready', url: null }),
    search: async q => { searches.push(`${q.keyword}:${q.page}`); return q.page !== 1 ? [] : q.keyword === 'Agent' ? [job('a1'), job('a2'), job('a3')] : [job('a1'), job('b1')]; },
    jobDetail: async c => `实际JD-${c.jobId}需要Python`, openJob: async () => ({ kind: 'canContact', evidence: '' }),
    contact: async t => { writes.push(`contact:${t.jobId}`); return { ok: true, evidence: '', identity: { jobId: t.jobId, recruiterUrl: `https://www.zhipin.com/boss_detail/${t.jobId}.html` } }; },
    readChat: async () => ({ ourMessages: 0, evidence: '' }), sendGreeting: async t => { writes.push(`greeting:${t.jobId}`); return { ok: true, evidence: '' }; },
  };
  const server = await startServer({ dataDir: dir, port: 0, site });
  const idle = () => new Promise<AppState>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); server.app.off('changed', check); };
    const check = () => void server.app.getState().then(s => {
      if (!s.chat.pending && s.discovery.status === 'idle' && s.research.status === 'idle' && s.batch?.status !== 'running') { cleanup(); resolve(s); }
    }, e => { cleanup(); reject(e); });
    const timer = setTimeout(() => { cleanup(); reject(new Error('任务未结束')); }, 10_000);
    server.app.on('changed', check); check();
  });
  return { mock, server, searches, writes, idle };
}

test('一句话按方向配额找岗、持久进度并写回对话；随后投吧发送草稿', async () => {
  const { mock, server, searches, writes, idle } = await setup([call('start_delivery', plan), end, decisions('a1', 'a2'), end, decisions('b1'), end, call('send_saved_batch', { quote: '投吧' }), end]);
  try {
    for (const endpoint of ['/api/discovery/start', '/api/research/start']) assert.equal((await api(server.url, 'POST', endpoint, {})).status, 404);
    assert.equal((await api(server.url, 'POST', '/api/chat', { message })).status, 200);
    const state = await idle();
    assert.deepEqual(state.discovery.directions, [{ name: 'AI开发', count: 2, selected: 2 }, { name: '后端', count: 1, selected: 1 }]);
    assert.deepEqual(state.batch!.targets.map(t => t.jobId), ['a1', 'a2', 'b1']);
    assert.deepEqual(searches, ['Agent:1', 'Python:1']);
    assert.deepEqual(writes, []);
    assert.match(state.chat.messages.filter(m => m.role === 'assistant').map(m => m.text).join('\n'), /AI开发.*2/);
    assert.ok(!state.chat.messages.some(m => m.text.includes('您好，我有Python经验')), '进度不贴招呼原文');
    assert.equal((await api(server.url, 'POST', '/api/chat', { message: '投吧' })).status, 200);
    const sent = await idle();
    assert.equal(sent.batch!.status, 'done');
    assert.equal(sent.contactedToday, 3);
    assert.equal(writes.length, 6);
    assert.match(sent.chat.messages.at(-1)!.text, /投递|执行/);
  } finally { await server.close(); mock.close(); }
});

for (const scenario of ['quote', 'quota'] as const) test(`对话工具拒绝${scenario}不满足的请求并让模型说明`, async () => {
  const args = scenario === 'quote' ? { ...plan, quote: '上轮的授权' } : plan;
  const { mock, server, searches, writes, idle } = await setup([
    call('start_delivery', args), call('reply', { text: '未启动，请按当前授权和剩余额度调整。' }), end,
  ], scenario === 'quota' ? 149 : 0);
  try {
    await api(server.url, 'POST', '/api/chat', { message });
    const state = await idle();
    assert.equal(state.discovery.startedAt, null);
    assert.deepEqual(searches, []); assert.deepEqual(writes, []);
    assert.match(JSON.stringify(mock.requests[1]?.input.at(-1)), scenario === 'quote' ? /原文|引用|最新/ : /剩余.*1|1.*额度/);
    assert.match(state.chat.messages.at(-1)!.text, /未启动/);
  } finally { await server.close(); mock.close(); }
});

for (const boundary of [
  { name: 'CDT午夜不清零', before: '2026-10-22T04:59:59.999Z', after: '2026-10-22T05:00:00.000Z', expected: 49 },
  { name: '北京时间零点清零', before: '2026-10-22T15:59:59.999Z', after: '2026-10-22T16:00:00.000Z', expected: 0 },
]) test(`今日联系采用北京时间：${boundary.name}`, t => {
  const previousZone = process.env.TZ;
  process.env.TZ = 'America/Chicago';
  t.mock.timers.enable({ apis: ['Date'], now: new Date(boundary.before) });
  const state = openState(path.join(tempDir('boss-beijing-day-'), 'state.sqlite'));
  try {
    const batch = state.replaceBatch(Array.from({ length: 50 }, (_, i) => ({ ...job(`day${i}`), reason: '测试', greeting: '您好' })));
    for (const target of batch.targets.slice(0, 49)) state.setStep(target, 'contact', 'unknown', '测试账本');
    assert.equal(state.snapshot().contactedToday, 49);
    t.mock.timers.setTime(new Date(boundary.after).getTime());
    assert.equal(state.snapshot().contactedToday, boundary.expected);
    if (boundary.expected === 49) assert.throws(() => requireQuota(102, state.snapshot().contactedToday), /101/);
    else assert.doesNotThrow(() => requireQuota(150, state.snapshot().contactedToday));
    state.setStep(batch.targets[49]!, 'contact', 'inflight', '边界后的新联系');
    assert.equal(state.snapshot().contactedToday, boundary.expected + 1);
    assert.equal(state.snapshot().contactedCount, 50, '日界线不能删除历史账本');
  } finally { state.close(); t.mock.timers.reset(); if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone; }
});

test('CDT午夜不能恢复已耗尽的北京时间额度，执行器拒绝新增联系', async t => {
  const previousZone = process.env.TZ;
  process.env.TZ = 'America/Chicago';
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-22T04:59:59.999Z') });
  const state = openState(path.join(tempDir('boss-beijing-quota-'), 'state.sqlite'));
  const calls: string[] = [];
  const site: WriteSite = {
    openJob: async () => { calls.push('open'); return { kind: 'canContact', evidence: '' }; },
    contact: async t => { calls.push('contact'); return { ok: true, evidence: '', identity: { jobId: t.jobId, recruiterUrl: 'https://www.zhipin.com/boss_detail/test.html' } }; },
    readChat: async () => ({ ourMessages: 0, evidence: '' }),
    sendGreeting: async () => { calls.push('greeting'); return { ok: true, evidence: '' }; },
  };
  try {
    const old = state.replaceBatch(Array.from({ length: 150 }, (_, i) => ({ ...job(`old${i}`), reason: '测试', greeting: '您好' })));
    old.targets.forEach(target => state.setStep(target, 'contact', 'done', '测试账本'));
    const batch = state.replaceBatch([{ ...job('new'), reason: '测试', greeting: '您好' }]);
    state.approve(batch.version);
    t.mock.timers.setTime(new Date('2026-10-22T05:00:00.000Z').getTime());
    await new Executor(state, site).start();
    assert.deepEqual(calls, [], '仍是北京时间同一天，不能再次联系');
    assert.equal(state.snapshot().batch!.status, 'paused');
    assert.match(state.snapshot().batch!.stopReason!, /额度/);
    assert.deepEqual(state.snapshot().batch!.targets[0]!.steps, { contact: 'todo', greeting: 'todo' });
  } finally { state.close(); t.mock.timers.reset(); if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone; }
});
