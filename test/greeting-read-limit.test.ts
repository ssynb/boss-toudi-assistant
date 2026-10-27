import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../src/server.ts';
import { openState } from '../src/state.ts';
import { DAILY_JOB_READ_LIMIT, GREETING_MAX_CHARS, type AppState } from '../src/contracts.ts';
import type { Site } from '../src/boss.ts';
import { api, countedSite, instantReadClock, tempDir } from './helpers.ts';
import { startMockModel, mockProviderToml, type MockItem } from './mock-responses.ts';

const greeting = '您好！\n希望了解这个岗位。';
const input = { requirements: '深圳AI开发，薪资不限', greeting, resume: { text: 'Python经验' } };
const job = (jobId: string) => ({ jobId, title: 'AI应用开发', company: '测试公司', salary: '20-40K', area: '深圳', snippet: '要求博士、10年经验、Java', url: `https://www.zhipin.com/job_detail/${jobId}.html` });
const draft = (jobId: string) => ({ ...job(jobId), reason: '匹配', greeting });
const end: MockItem[] = [{ type: 'message', text: '完成' }];
const call = (name: string, args: unknown): MockItem[] => [{ type: 'function_call', name, args }];
const message = '深圳AI开发，薪资不限，找2个';
const plan = (sendNow: boolean) => call('start_delivery', { city: '深圳', salaryMinK: null, criteria: 'AI开发大类', sendNow, quote: message, directions: [{ name: 'AI开发', keywords: ['AI开发'], count: 2 }] });
const choose = (jobId: string) => call('submit_decisions', { decisions: [{ jobId, decision: 'select', reason: '主要职责属于AI应用开发', greeting: '模型伪造的不同招呼' }] });

async function setup(script: MockItem[][], savedGreeting = greeting, used = 0) {
  const mock = await startMockModel(script);
  const dir = tempDir('boss-fixed-limit-');
  fs.mkdirSync(path.join(dir, 'codex-home'));
  fs.writeFileSync(path.join(dir, 'codex-home', 'config.toml'), mockProviderToml(mock.baseUrl, 'gpt-mock'));
  const state = openState(path.join(dir, 'state.sqlite'));
  try {
    state.saveInputs({ ...input, greeting: savedGreeting });
    for (let i = 0; i < used; i++) state.recordJobRead();
  } catch (error) { mock.close(); throw error; }
  finally { state.close(); }
  const calls: string[] = [];
  const texts: string[] = [];
  const site: Site = {
    open: async () => ({ page: 'ready', url: null }), status: async () => ({ page: 'ready', url: null }), close: async () => {},
    search: async q => q.page === 1 ? [job('a'), job('b')] : [],
    jobDetail: async c => { calls.push(`detail:${c.jobId}`); return '主要职责：AI应用开发；JD写了博士、10年经验、Java，但用户未要求这些'; },
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
  return { mock, dir, server, site, calls, texts, idle };
}

test('固定招呼语同事务保存与校验，更新未发送草稿但不改已发送历史', () => {
  const state = openState(path.join(tempDir('boss-fixed-'), 'state.sqlite'));
  try {
    state.saveInputs({ ...input, greeting: `  ${greeting}  ` });
    assert.equal(state.snapshot().greeting, greeting);
    const batch = state.replaceBatch([draft('a'), draft('b')]);
    state.setStep(batch.targets[0]!, 'contact', 'done', '已联系');
    state.setStep(batch.targets[0]!, 'greeting', 'done', '已送达');
    state.approve(batch.version);
    state.saveInputs({ ...input, greeting: '新的固定招呼' });
    const updated = state.snapshot();
    assert.equal(updated.batch!.status, 'draft');
    assert.equal(updated.batch!.version, batch.version + 1);
    assert.equal(updated.batch!.targets[0]!.greeting, greeting);
    assert.equal(updated.batch!.targets[1]!.greeting, '新的固定招呼');
    assert.throws(() => state.patchTarget(updated.batch!.targets[1]!.id, { greeting: '单岗位自定义' }), /个人信息|固定招呼/);
    for (const invalid of [undefined, '字'.repeat(GREETING_MAX_CHARS + 1)]) {
      assert.throws(() => state.saveInputs({ ...input, greeting: invalid as string }), /招呼/);
      assert.deepEqual(state.snapshot(), updated);
    }
    state.saveInputs({ ...input, greeting: ` ${'字'.repeat(GREETING_MAX_CHARS)} ` });
    assert.equal(state.snapshot().greeting.length, GREETING_MAX_CHARS);
  } finally { state.close(); }
});

test('固定招呼写入真实SQLite失败时简历、要求、固定文本和批准全部回滚', () => {
  const file = path.join(tempDir('boss-fixed-atomic-'), 'state.sqlite');
  let state = openState(file);
  state.saveInputs(input);
  const batch = state.replaceBatch([draft('a')]); state.approve(batch.version);
  const before = state.snapshot(); state.close();
  const db = new DatabaseSync(file);
  db.exec("CREATE TRIGGER deny_greeting BEFORE INSERT ON kv WHEN NEW.key = 'greeting' BEGIN SELECT RAISE(ABORT, 'greeting storage failure'); END"); db.close();
  state = openState(file);
  try {
    assert.throws(() => state.saveInputs({ greeting: '新招呼', requirements: '新要求', resume: { text: '新简历' } }), /greeting storage failure/);
    assert.deepEqual(state.snapshot(), before);
  } finally { state.close(); }
});

test('真实Codex判定不生成招呼，逐字发送固定文本；读JD后的同页执行不重复计数', async () => {
  const { mock, server, calls, texts, idle } = await setup([plan(true), end, choose('a'), end, choose('b'), end]);
  try {
    await api(server.url, 'POST', '/api/chat', { message });
    const state = await idle();
    assert.equal(state.greeting, greeting); assert.equal(state.greetingMaxChars, GREETING_MAX_CHARS);
    assert.equal(state.dailyJobReadLimit, DAILY_JOB_READ_LIMIT); assert.equal(state.jobReadsToday, 2);
    assert.deepEqual(texts, [greeting, greeting]);
    assert.deepEqual(state.batch!.targets.map(t => t.greeting), [greeting, greeting]);
    assert.deepEqual(calls, ['detail:a', 'open:a', 'contact:a', 'detail:b', 'open:b', 'contact:b']);
    assert.ok(!JSON.stringify(mock.requests[2]!.tools).includes('"greeting"'), '判定工具不提供greeting参数');
  } finally { try { await server.close(); } finally { mock.close(); } }
});

for (const sendNow of [false, true]) test(`未配置固定招呼拒绝开始找岗/投递：${sendNow}`, async () => {
  const { mock, server, calls, texts, idle } = await setup([plan(sendNow), call('reply', { text: '请去个人信息页设置固定招呼语并保存。' }), end], '');
  try {
    await api(server.url, 'POST', '/api/chat', { message });
    const state = await idle();
    assert.equal(state.discovery.startedAt, null);
    assert.deepEqual(calls, []); assert.deepEqual(texts, []);
    assert.match(JSON.stringify(mock.requests[1]?.input.at(-1)), /个人信息.*招呼/);
    assert.match(state.chat.messages.at(-1)!.text, /个人信息/);
  } finally { try { await server.close(); } finally { mock.close(); } }
});

for (const sendNow of [false, true]) test(`达到日浏览上限停止并保留已选，不再打开或联系：${sendNow}`, async () => {
  const decisions = sendNow ? [choose('a'), end, choose('b'), end] : [call('submit_decisions', { decisions: ['a', 'b'].map(jobId => ({ jobId, decision: 'select', reason: '方向匹配' })) }), end];
  const { mock, server, calls, texts, idle } = await setup([plan(sendNow), end, ...decisions], greeting, 298);
  try {
    await api(server.url, 'POST', '/api/chat', { message });
    const state = await idle();
    assert.equal(state.jobReadsToday, 300);
    assert.equal(state.batch!.targets.length, 2);
    assert.equal(state.batch!.status, sendNow ? 'paused' : 'draft');
    assert.match(state.chat.messages.map(m => m.text).join('\n'), /今日浏览上限已到，明天继续/);
    assert.deepEqual(calls.filter(x => x.startsWith('detail:')), ['detail:a', 'detail:b']);
    assert.deepEqual(texts, sendNow ? [greeting] : []);
    assert.equal(state.batch!.targets[1]!.steps.contact, 'todo');
  } finally { try { await server.close(); } finally { mock.close(); } }
});

test('日浏览额度已尽时新任务在模型工具边界被拒绝', async () => {
  const { mock, server, calls, idle } = await setup([plan(false), call('reply', { text: '今日浏览上限已到，明天继续。' }), end], greeting, 300);
  try {
    await api(server.url, 'POST', '/api/chat', { message });
    const state = await idle();
    assert.equal(state.discovery.startedAt, null); assert.deepEqual(calls, []);
    assert.match(JSON.stringify(mock.requests[1]?.input.at(-1)), /今日浏览上限已到，明天继续/);
  } finally { try { await server.close(); } finally { mock.close(); } }
});

test('岗位页额度持久化，按北京时间换日，不随CDT午夜清零', t => {
  const oldZone = process.env.TZ; process.env.TZ = 'America/Chicago';
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-26T04:59:59Z') });
  const file = path.join(tempDir('boss-read-day-'), 'state.sqlite');
  let state = openState(file);
  try {
    for (let i = 0; i < 300; i++) state.recordJobRead();
    t.mock.timers.setTime(new Date('2026-10-26T05:00:00Z').getTime());
    assert.equal(state.snapshot().jobReadsToday, 300);
    assert.throws(() => state.recordJobRead(), /今日浏览上限/);
    state.close(); state = openState(file);
    assert.equal(state.snapshot().jobReadsToday, 300);
    t.mock.timers.setTime(new Date('2026-10-26T16:00:00Z').getTime());
    assert.equal(state.snapshot().jobReadsToday, 0);
    state.recordJobRead(); assert.equal(state.snapshot().jobReadsToday, 1);
  } finally { state.close(); t.mock.timers.reset(); if (oldZone === undefined) delete process.env.TZ; else process.env.TZ = oldZone; }
});

for (const rejection of [
  { rejectionCategory: '年限学历', reason: 'JD要求博士与10年经验' },
  { rejectionCategory: '技术栈不符', reason: 'JD要求Java，简历只有Python' },
  { rejectionCategory: '用户明确条件', reason: 'JD要求本科', requirementQuote: '必须本科' },
]) test(`未被用户指定的软条件不能作为拒绝依据：${rejection.rejectionCategory}`, async () => {
  const { mock, server, site, idle } = await setup([
    plan(false), end,
    call('submit_decisions', { decisions: [{ jobId: 'a', decision: 'reject', ...rejection }] }), choose('a'), end,
  ]);
  site.search = async q => q.page === 1 ? [job('a')] : [];
  try {
    await api(server.url, 'POST', '/api/chat', { message });
    const state = await idle();
    assert.equal(state.batch!.targets[0]!.jobId, 'a');
    assert.match(JSON.stringify(mock.requests[3]?.input.at(-1)), /类别|用户|原文/);
  } finally { try { await server.close(); } finally { mock.close(); } }
});

test('用户明确要求的额外条件仍可拒绝，需引用用户原文而不是JD', async () => {
  const { mock, server, site, idle } = await setup([
    plan(false), end, call('submit_decisions', { decisions: [{ jobId: 'a', decision: 'reject', reason: '不满足用户明确学历要求', rejectionCategory: '用户明确条件', requirementQuote: '必须本科' }] }), end,
  ]);
  site.search = async q => q.page === 1 ? [job('a')] : [];
  try {
    await api(server.url, 'PUT', '/api/inputs', { ...input, requirements: '必须本科' });
    await api(server.url, 'POST', '/api/chat', { message });
    const state = await idle();
    assert.match(state.discovery.message!, /用户明确条件 1/);
    assert.equal(state.batch, null);
  } finally { try { await server.close(); } finally { mock.close(); } }
});
