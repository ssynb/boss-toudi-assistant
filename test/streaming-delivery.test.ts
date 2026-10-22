import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, type RunningServer } from '../src/server.ts';
import { openState } from '../src/state.ts';
import { Executor, type WriteSite } from '../src/executor.ts';
import { SiteBlockedError, type Site } from '../src/boss.ts';
import type { AppState } from '../src/contracts.ts';
import { instantReadClock, tempDir, api } from './helpers.ts';
import { startMockModel, mockProviderToml, type MockItem } from './mock-responses.ts';

const message = '深圳AI开发，薪资不限，找到就投';
const plan = (count: number) => ({ city: '深圳', salaryMinK: null, criteria: 'Python开发', sendNow: true, quote: message, directions: [{ name: 'AI开发', keywords: ['Python'], count }] });
const end: MockItem[] = [{ type: 'message', text: '完成' }];
const call = (name: string, args: unknown): MockItem[] => [{ type: 'function_call', name, args }];
const judge = (jobId: string) => call('submit_decisions', { decisions: [{ jobId, decision: 'select', reason: '实际JD匹配Python经验', greeting: '您好，我有Python经验' }] });
const card = (jobId: string) => ({ jobId, company: `公司${jobId}`, title: '工程师', salary: '20-40K', area: '深圳', snippet: '', url: `https://www.zhipin.com/job_detail/${jobId}.html` });
const draft = (jobId: string) => ({ ...card(jobId), reason: '匹配', greeting: '您好' });

function idle(server: RunningServer): Promise<AppState> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); server.app.off('changed', check); };
    const check = () => void server.app.getState().then(s => {
      if (!s.chat.pending && s.discovery.status === 'idle' && s.batch?.status !== 'running') { cleanup(); resolve(s); }
    }, e => { cleanup(); reject(e); });
    const timer = setTimeout(() => { cleanup(); reject(new Error('任务未结束')); }, 10_000);
    server.app.on('changed', check); check();
  });
}

async function setup(count: number, ids: string[], tail: MockItem[][] = []) {
  const mock = await startMockModel([call('start_delivery', plan(count)), end, ...ids.flatMap(id => [judge(id), end]), ...tail]);
  const dir = tempDir('boss-stream-');
  fs.mkdirSync(path.join(dir, 'codex-home'));
  fs.writeFileSync(path.join(dir, 'codex-home', 'config.toml'), mockProviderToml(mock.baseUrl, 'gpt-mock'));
  const state = openState(path.join(dir, 'state.sqlite'));
  state.saveInputs({ requirements: '', resume: { text: 'Python开发经验' } });
  state.replaceBatch([draft('old')]);
  state.close();
  const events: string[] = [];
  const site: Site = {
    open: async () => ({ page: 'ready', url: null }), status: async () => ({ page: 'ready', url: null }), close: async () => {},
    search: async q => q.page === 1 ? ids.map(card) : [],
    jobDetail: async c => { events.push(`detail:${c.jobId}`); return `实际JD-${c.jobId} Python开发`; },
    openJob: async t => { events.push(`open:${t.jobId}`); return { kind: 'canContact', evidence: '' }; },
    contact: async t => { events.push(`contact:${t.jobId}`); return { ok: true, evidence: '', identity: { jobId: t.jobId, recruiterUrl: `https://www.zhipin.com/boss_detail/${t.jobId}.html` } }; },
    readChat: async () => ({ ourMessages: 0, evidence: '' }),
    sendGreeting: async t => { events.push(`greeting:${t.jobId}`); return { ok: true, evidence: '已送达' }; },
  };
  const server = await startServer({ readClock: instantReadClock, dataDir: dir, port: 0, site });
  return { mock, dir, server, site, events };
}

test('找到就投：先送达再读下一个JD；同一运行批次追加，跳过和失败仍计入选配额', async () => {
  const { mock, server, site, events } = await setup(3, ['ok', 'same', 'missing']);
  site.search = async () => ['ok', 'same', 'missing', 'unused'].map(card);
  const versions: number[] = [];
  const batches = new Set<string>();
  site.openJob = async t => {
    events.push(`open:${t.jobId}`);
    const state = await server.app.getState();
    assert.equal(state.batch!.status, 'running');
    versions.push(state.batch!.version); batches.add(state.batch!.id);
    if (t.jobId === 'same') return { kind: 'alreadyContacted', evidence: '同招聘者其他岗位已有会话' };
    if (t.jobId === 'missing') return { kind: 'missing', evidence: '无沟通入口' };
    return { kind: 'canContact', evidence: '' };
  };
  const contact = site.contact;
  site.contact = async t => {
    const state = await server.app.getState();
    assert.equal(state.batch!.targets.find(target => target.id === t.id)!.steps.contact, 'inflight');
    assert.equal(state.contactedToday, 1, '联系前已写账本');
    return contact(t);
  };
  try {
    await api(server.url, 'POST', '/api/chat', { message });
    const state = await idle(server);
    assert.deepEqual(events, ['detail:ok', 'open:ok', 'contact:ok', 'greeting:ok', 'detail:same', 'open:same', 'detail:missing', 'open:missing']);
    assert.equal(batches.size, 1); assert.deepEqual(versions, [2, 3, 4]);
    assert.equal(state.batch!.status, 'done');
    assert.deepEqual(state.discovery.directions, [{ name: 'AI开发', count: 3, selected: 3 }]);
    assert.match(state.chat.messages.at(-1)!.text, /入选.*3.*送达.*1.*跳过.*1.*失败.*1/);
  } finally { await server.close(); mock.close(); }
});

test('停止发现同时暂停当前执行：在途联系结束后不发招呼，投吧只继续已选待做步骤', async () => {
  const { mock, server, site, events } = await setup(2, ['a'], [call('send_saved_batch', { quote: '投吧' }), end]);
  site.search = async () => [card('a'), card('b')];
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let entered!: () => void;
  const inContact = new Promise<void>(r => { entered = r; });
  const contact = site.contact;
  site.contact = async t => { entered(); await gate; return contact(t); };
  try {
    await api(server.url, 'POST', '/api/chat', { message });
    await Promise.race([inContact, idle(server).then(() => { throw new Error('首个入选应已开始联系'); })]);
    const stopped = await api<AppState>(server.url, 'POST', '/api/discovery/stop');
    assert.equal(stopped.json.discovery.status, 'stopping');
    assert.equal(stopped.json.batch!.targets[0]!.steps.contact, 'inflight');
    release();
    const paused = await idle(server);
    assert.equal(paused.batch!.status, 'paused');
    assert.deepEqual(paused.batch!.targets[0]!.steps, { contact: 'done', greeting: 'todo' });
    assert.deepEqual(events, ['detail:a', 'open:a', 'contact:a']);
    await api(server.url, 'POST', '/api/chat', { message: '投吧' });
    const done = await idle(server);
    assert.equal(done.batch!.id, paused.batch!.id);
    assert.equal(done.batch!.status, 'done');
    assert.deepEqual(events, ['detail:a', 'open:a', 'contact:a', 'greeting:a']);
  } finally { release(); await server.close(); mock.close(); }
});

for (const failure of ['blocked', 'unknown', 'later-read'] as const) test(`边找边投遇到${failure}整体暂停，保留已选及真实执行状态`, async () => {
  const { mock, server, site, events } = await setup(2, ['a'], [call('send_saved_batch', { quote: '继续' }), end]);
  site.search = async () => [card('a'), card('b')];
  if (failure === 'blocked') site.openJob = async () => ({ kind: 'blocked', evidence: '登录失效' });
  if (failure === 'unknown') site.contact = async t => { events.push(`contact:${t.jobId}`); return { ok: false, evidence: '无法核实结果' }; };
  if (failure === 'later-read') {
    const read = site.jobDetail;
    site.jobDetail = async c => { if (c.jobId === 'b') throw new SiteBlockedError({ page: 'verify', url: null }); return read(c); };
  }
  try {
    await api(server.url, 'POST', '/api/chat', { message });
    const state = await idle(server);
    assert.equal(state.batch!.status, 'paused');
    assert.equal(state.batch!.targets[0]!.jobId, 'a');
    assert.equal(state.batch!.targets[0]!.steps.contact, failure === 'blocked' ? 'todo' : failure === 'unknown' ? 'unknown' : 'done');
    assert.equal(state.batch!.targets[0]!.steps.greeting, failure === 'later-read' ? 'done' : failure === 'unknown' ? 'skipped' : 'todo');
    assert.ok(!events.includes('detail:b'), '执行阻塞后不再继续发现；读取阶段风控也不伪造详情');
    if (failure === 'unknown') {
      await api(server.url, 'POST', '/api/chat', { message: '继续' });
      const resumed = await idle(server);
      assert.equal(resumed.batch!.targets[0]!.steps.contact, 'unknown');
      assert.equal(events.filter(event => event === 'contact:a').length, 1, '未确认不重试');
      assert.ok(!events.includes('greeting:a'));
    }
  } finally { await server.close(); mock.close(); }
});

function streamingState(count: number) {
  const file = path.join(tempDir('boss-stream-state-'), 'state.sqlite');
  const state = openState(file);
  state.saveInputs({ requirements: '', resume: { text: 'Python开发经验' } });
  return { state, file, begin: () => state.beginDiscovery(true, [{ name: 'AI开发', count, selected: 0 }], plan(count)) };
}

test('逐目标执行前复核每日额度：最后一个名额用完，下一目标保留todo并暂停', async () => {
  const { state, begin } = streamingState(2);
  const old = state.replaceBatch(Array.from({ length: 149 }, (_, i) => draft(`old${i}`)));
  old.targets.forEach(t => state.setStep(t, 'contact', 'done', '历史联系'));
  begin();
  const calls: string[] = [];
  const site: WriteSite = {
    openJob: async t => { calls.push(`open:${t.jobId}`); return { kind: 'canContact', evidence: '' }; },
    contact: async t => { calls.push(`contact:${t.jobId}`); return { ok: true, evidence: '', identity: { jobId: t.jobId, recruiterUrl: 'https://www.zhipin.com/boss_detail/hr.html' } }; },
    readChat: async () => ({ ourMessages: 0, evidence: '' }), sendGreeting: async t => { calls.push(`greeting:${t.jobId}`); return { ok: true, evidence: '' }; },
  };
  try {
    const executor = new Executor(state, site);
    const first = state.appendStreamingTarget(draft('a'));
    assert.equal(await executor.runTarget(first.id), true);
    const second = state.appendStreamingTarget(draft('b'));
    assert.equal(await executor.runTarget(second.id), false);
    assert.deepEqual(calls, ['open:a', 'contact:a', 'greeting:a']);
    assert.equal(state.snapshot().contactedToday, 150);
    assert.equal(state.snapshot().batch!.status, 'paused');
    assert.match(state.snapshot().batch!.stopReason!, /额度/);
    assert.deepEqual(state.snapshot().batch!.targets[1]!.steps, { contact: 'todo', greeting: 'todo' });
  } finally { state.close(); }
});

test('流式追加只有本轮找到就投授权可用；重启保留版本、未确认账本和待执行目标', async () => {
  const fixture = streamingState(2);
  let state = fixture.state;
  assert.throws(() => state.appendStreamingTarget(draft('forged')));
  state.beginDiscovery(false, [{ name: 'AI开发', count: 2, selected: 0 }], { ...plan(2), sendNow: false });
  assert.throws(() => state.appendStreamingTarget(draft('draft-mode')));
  state.finishDiscovery('结束');
  fixture.begin();
  const first = state.appendStreamingTarget(draft('a'));
  assert.throws(() => state.appendStreamingTarget(draft('a')), '同岗位不能重复追加');
  state.appendStreamingTarget(draft('b'));
  assert.throws(() => state.appendStreamingTarget(draft('over-quota')), '不能超出本轮已授权总配额');
  state.setStep(first, 'contact', 'inflight', '崩溃前写账本');
  const batch = state.snapshot().batch!;
  state.close();
  state = openState(fixture.file);
  const calls: string[] = [];
  const site: WriteSite = {
    openJob: async t => { calls.push(`open:${t.jobId}`); return { kind: 'canContact', evidence: '' }; },
    contact: async t => { calls.push(`contact:${t.jobId}`); return { ok: true, evidence: '', identity: { jobId: t.jobId, recruiterUrl: 'https://www.zhipin.com/boss_detail/hr.html' } }; },
    readChat: async () => ({ ourMessages: 0, evidence: '' }), sendGreeting: async t => { calls.push(`greeting:${t.jobId}`); return { ok: true, evidence: '' }; },
  };
  try {
    const recovered = state.snapshot();
    assert.equal(recovered.batch!.id, batch.id); assert.equal(recovered.batch!.version, batch.version);
    assert.equal(recovered.batch!.status, 'paused'); assert.equal(recovered.discovery.status, 'idle');
    assert.equal(recovered.batch!.targets[0]!.steps.contact, 'unknown');
    assert.equal(state.isContacted('a'), true);
    assert.deepEqual(recovered.batch!.targets[1]!.steps, { contact: 'todo', greeting: 'todo' });
    assert.throws(() => state.approve(batch.version - 1), { code: 'stale_version' });
    state.approve(batch.version);
    await new Executor(state, site).start();
    assert.deepEqual(calls, ['open:b', 'contact:b', 'greeting:b']);
    assert.equal(state.snapshot().batch!.targets[0]!.steps.contact, 'unknown');
  } finally { state.close(); }
});
