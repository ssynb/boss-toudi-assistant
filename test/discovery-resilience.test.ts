import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, type RunningServer } from '../src/server.ts';
import { openState } from '../src/state.ts';
import { SiteBlockedError, type Site } from '../src/boss.ts';
import type { AppState } from '../src/contracts.ts';
import { api, tempDir } from './helpers.ts';
import { startMockModel, mockProviderToml, type MockItem } from './mock-responses.ts';

const end: MockItem[] = [{ type: 'message', text: '完成' }];
const call = (name: string, args: unknown): MockItem[] => [{ type: 'function_call', name, args }];
const message = '深圳AI开发，月薪至少30K，找10个直接投递';
const plan = { city: '深圳', salaryMinK: 30, criteria: 'Python和Agent开发', sendNow: true, quote: message, directions: [{ name: 'AI开发', keywords: ['Agent'], count: 10 }] };
const decision = (jobId: string, select = true) => ({ jobId, decision: select ? 'select' : 'reject', reason: select ? '实际JD匹配Python经验' : '猎头不符合用户排除条件', ...(select ? { greeting: '您好，我有Python经验' } : {}) });
const judge = (...jobIds: string[]) => call('submit_decisions', { decisions: jobIds.map(id => decision(id)) });
const card = (jobId: string) => ({ jobId, title: 'AI工程师', company: jobId, salary: '30-40K', area: '深圳', snippet: '', url: `https://www.zhipin.com/job_detail/${jobId}.html` });
const timeout = () => new Error('浏览器命令 wait 失败：Wait timed out after 25000ms');

async function setup(script: MockItem[][]) {
  const mock = await startMockModel(script);
  const dir = tempDir('boss-resilience-');
  fs.mkdirSync(path.join(dir, 'codex-home'));
  fs.writeFileSync(path.join(dir, 'codex-home', 'config.toml'), mockProviderToml(mock.baseUrl, 'gpt-mock'));
  const db = openState(path.join(dir, 'state.sqlite'));
  db.saveInputs({ requirements: '', resume: { text: 'Python与Agent开发经验' } });
  const original = db.replaceBatch([{ ...card('old'), reason: '原批次', greeting: '您好' }]);
  db.close();
  const writes: string[] = [];
  const site: Site = {
    open: async () => ({ page: 'ready', url: null }), close: async () => {}, status: async () => ({ page: 'ready', url: null }),
    search: async () => [], jobDetail: async c => `实际JD-${c.jobId} Python开发`,
    openJob: async () => ({ kind: 'canContact', evidence: '' }),
    contact: async t => { writes.push(`contact:${t.jobId}`); return { ok: true, evidence: '', identity: { jobId: t.jobId, recruiterUrl: `https://www.zhipin.com/boss_detail/${t.jobId}.html` } }; },
    readChat: async () => ({ ourMessages: 0, evidence: '' }),
    sendGreeting: async t => { writes.push(`greeting:${t.jobId}`); return { ok: true, evidence: '' }; },
  };
  const server = await startServer({ dataDir: dir, port: 0, site });
  return { mock, dir, server, site, writes, original };
}

function idle(server: RunningServer): Promise<AppState> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); server.app.off('changed', check); };
    const check = () => void server.app.getState().then(s => {
      if (!s.chat.pending && s.discovery.status === 'idle' && s.batch?.status !== 'running') { cleanup(); resolve(s); }
    }, e => { cleanup(); reject(e); });
    const timer = setTimeout(() => { cleanup(); reject(new Error('发现未结束')); }, 10_000);
    server.app.on('changed', check); check();
  });
}

function context(mock: { requests: { input: unknown[] }[] }, index: number): Record<string, any> {
  const user = mock.requests[index]!.input.filter(item => (item as { role?: string }).role === 'user').at(-1) as { content: { text: string }[] };
  return JSON.parse(user.content[0]!.text);
}

test('单页与单JD失败仅重试一次，跳过后继续找岗并报告失败计数', async () => {
  const latest = `${message}，不要猎头、中介、外包`;
  const { mock, server, site, writes } = await setup([call('start_delivery', { ...plan, quote: latest, sendNow: false, directions: [{ ...plan.directions[0], count: 2 }] }), end, judge('good1'), end, judge('good2'), end]);
  const searches: number[] = [];
  const details: string[] = [];
  site.search = async q => {
    searches.push(q.page);
    if (q.page === 1 && searches.length === 1 || q.page === 2) throw timeout();
    return q.page === 1 ? [card('bad'), card('good1')] : [card('good2')];
  };
  site.jobDetail = async c => { details.push(c.jobId); if (c.jobId === 'bad' || c.jobId === 'good1' && details.filter(id => id === 'good1').length === 1) throw timeout(); return '实际JD Python开发'; };
  try {
    await api(server.url, 'POST', '/api/chat', { message: latest });
    const state = await idle(server);
    assert.deepEqual(state.batch!.targets.map(t => t.jobId), ['good1', 'good2']);
    assert.deepEqual(searches, [1, 1, 2, 2, 3]);
    for (const excluded of ['猎头', '中介', '外包']) assert.ok(context(mock, 2).criteria.includes(excluded), '明确排除条件必须传入实际JD判定');
    assert.deepEqual(details, ['bad', 'bad', 'good1', 'good1', 'good2']);
    assert.match(state.discovery.message!, /搜索失败.*1/);
    assert.match(state.discovery.message!, /详情失败.*1/);
    assert.deepEqual(writes, []);
  } finally { await server.close(); mock.close(); }
});

for (const mode of ['pages', 'details'] as const) test(`只找不投连续${mode}失败提前结束：保存入选草稿，投吧才发`, async () => {
  const { mock, server, site, writes, original } = await setup([call('start_delivery', { ...plan, sendNow: false }), end, judge('good'), end, call('send_saved_batch', { quote: '投吧' }), end]);
  const searches: number[] = [];
  const badReads: string[] = [];
  site.search = async q => {
    searches.push(q.page);
    if (q.page === 1) return [card('good')];
    if (mode === 'pages') throw timeout();
    return Array.from({ length: 6 }, (_, i) => card(`bad${i}`));
  };
  site.jobDetail = async c => { if (c.jobId !== 'good') { badReads.push(c.jobId); throw timeout(); } return '实际JD Python开发'; };
  try {
    await api(server.url, 'POST', '/api/chat', { message });
    const state = await idle(server);
    assert.notEqual(state.batch!.id, original.id, '新需求：站点连续异常保留已经正常入选的结果');
    assert.deepEqual(state.batch!.targets.map(t => t.jobId), ['good']);
    assert.equal(state.batch!.status, 'draft');
    assert.match(state.discovery.message!, /因站点异常提前结束/);
    assert.match(state.discovery.message!, /未自动发送|不自动发送/);
    assert.deepEqual(writes, []);
    if (mode === 'pages') assert.deepEqual(searches, [1, 2, 2, 3, 3, 4, 4]);
    else assert.deepEqual(badReads, ['bad0', 'bad0', 'bad1', 'bad1', 'bad2', 'bad2', 'bad3', 'bad3', 'bad4', 'bad4']);
    await api(server.url, 'POST', '/api/chat', { message: '投吧' });
    const sent = await idle(server);
    assert.equal(sent.batch!.status, 'done');
    assert.deepEqual(writes, ['contact:good', 'greeting:good']);
  } finally { await server.close(); mock.close(); }
});

for (const ending of ['blocked', 'cancelled'] as const) test(`只找不投${ending}：不重试、不替换原批次`, async () => {
  const { mock, server, site, writes, original } = await setup([call('start_delivery', { ...plan, sendNow: false }), end, judge('good'), end]);
  let failedCalls = 0;
  site.search = async q => {
    if (q.page === 1) return [card('good')];
    failedCalls++;
    if (ending === 'blocked') throw new SiteBlockedError({ page: 'verify', url: null });
    server.app.stopDiscovery();
    throw timeout();
  };
  try {
    await api(server.url, 'POST', '/api/chat', { message });
    const state = await idle(server);
    assert.equal(failedCalls, 1);
    assert.deepEqual(state.batch, original);
    assert.deepEqual(writes, []);
    assert.match(state.discovery.message!, ending === 'blocked' ? /验证/ : /停止/);
  } finally { await server.close(); mock.close(); }
});

test('失败任务重启后仍向顾问提供计划与原因；最新继续意图可沿用排除猎头条件', async () => {
  const initial = '深圳AI开发，月薪至少30K，再投147个，不要再给猎头投了';
  const again = '开始投啊 再投147个';
  const fullPlan = { ...plan, quote: initial, directions: [{ ...plan.directions[0], count: 147 }] };
  const { mock, dir, server, site, writes } = await setup([
    call('start_delivery', fullPlan), end,
    call('start_delivery', { ...fullPlan, quote: again }), end,
    call('submit_decisions', { decisions: [decision('headhunter', false)] }), end,
    call('submit_decisions', { decisions: [decision('direct')] }), end,
    call('reply', { text: '本轮已送达1个岗位。' }), end,
  ]);
  site.search = async () => { throw timeout(); };
  let current = server;
  try {
    await api(current.url, 'POST', '/api/chat', { message: initial });
    await idle(current);
    await current.close();
    site.search = async q => q.page === 1 ? [card('headhunter'), card('direct')] : [];
    current = await startServer({ dataDir: dir, port: 0, site });
    await api(current.url, 'POST', '/api/chat', { message: again });
    const state = await idle(current);
    const previous = context(mock, 2).lastTask;
    assert.ok(previous, '顾问需要最近任务摘要，不能因最新消息没重复城市而遗忘计划');
    assert.equal(previous.kind, 'delivery');
    assert.equal(previous.plan.city, '深圳');
    assert.equal(previous.plan.salaryMinK, 30);
    assert.equal(previous.plan.directions[0].count, 147);
    assert.deepEqual(previous.plan.directions[0].keywords, ['Agent']);
    assert.match(previous.plan.criteria, /猎头/);
    assert.match(previous.result, /timed out|提前结束/);
    assert.equal(previous.selected, 0); assert.equal(previous.delivered, 0);
    assert.match(context(mock, 4).criteria, /排除猎头|不要.*猎头/, '模型遗漏排除条件时程序仍把用户约束传入JD判定');
    const recap = state.chat.messages.filter(m => m.role === 'assistant').map(m => m.text).join('\n');
    assert.match(recap, /深圳.*30.*猎头/);
    assert.deepEqual(writes, ['contact:direct', 'greeting:direct']);
    await api(current.url, 'POST', '/api/chat', { message: '上轮结果如何？' });
    await idle(current);
    assert.equal(context(mock, 8).lastTask.selected, 1);
    assert.equal(context(mock, 8).lastTask.delivered, 1);
  } finally { await current.close(); mock.close(); }
});


test('清空对话并重启后继续：顾问判定条件不恢复已经解除的外包排除', async () => {
  const initial = '深圳AI开发，月薪至少30K，找10个，允许外包，先存草稿';
  const again = '继续，只找不投';
  const oldCriteria = 'Python，排除外包';
  const { mock, dir, server, site, writes } = await setup([
    call('start_delivery', { ...plan, quote: initial, criteria: oldCriteria, sendNow: false }), end,
    call('start_delivery', { ...plan, quote: again, criteria: oldCriteria, sendNow: false }), end,
    judge('agency'), end,
  ]);
  let current = server;
  try {
    await api(current.url, 'POST', '/api/chat', { message: initial });
    await idle(current);
    assert.equal((await api(current.url, 'POST', '/api/chat/clear')).status, 200);
    await current.close();
    site.search = async q => q.page === 1 ? [card('agency')] : [];
    current = await startServer({ dataDir: dir, port: 0, site });
    await api(current.url, 'POST', '/api/chat', { message: again });
    const state = await idle(current);
    assert.equal(context(mock, 2).messages.length, 1, '旧对话已清空，续接只依赖持久任务计划');
    assert.equal(context(mock, 4).criteria, '用户明确限制（优先于下文）：不再排除外包。Python，排除外包');
    assert.deepEqual(state.batch!.targets.map(target => target.jobId), ['agency']);
    assert.deepEqual(writes, []);
  } finally { await current.close(); mock.close(); }
});
