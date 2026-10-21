import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startServer, type RunningServer } from '../src/server.ts';
import { openState } from '../src/state.ts';
import { SiteBlockedError, SUPPORTED_CITIES, type Site } from '../src/boss.ts';
import { CHAT_HISTORY_LIMIT, CHAT_MESSAGE_MAX_CHARS, RESEARCH_SAMPLE_PER_DIRECTION, type AppState } from '../src/contracts.ts';
import { api, tempDir } from './helpers.ts';
import { mockProviderToml, startMockModel, type MockItem } from './mock-responses.ts';

const names = ['AI开发', 'Agent开发', 'AI产品', 'FDE', '后端'];
const end: MockItem[] = [{ type: 'message', text: '完成' }];
const call = (name: string, args: unknown): MockItem[] => [{ type: 'function_call', name, args }];
const researchAction = call('start_research', { city: '北京', quote: '调研北京方向' });
const plan = call('suggest_directions', { directions: names.map(name => ({ name, keywords: [name] })) });
const evaluation = (fit: string, matched = 2) => call('evaluate_direction', { fit, reason: '实际JD需要已有Python与Agent经验', gaps: '需要补充生产项目规模经验', matched });
const reply = (text: string) => call('reply', { text });
const inputs = { requirements: '希望探索AI方向', resume: { text: 'Python后端、Agent项目、客户交付和产品设计经验' } };
const job = (id: string, salary = '20-30K') => ({ jobId: id, company: '测试公司', title: '工程师', salary, url: `https://www.zhipin.com/job_detail/${id}.html`, area: '北京', snippet: '卡片不是实际JD' });

async function fixture(script: MockItem[][], baseUrl?: string) {
  const mock = await startMockModel(script);
  const dir = tempDir('boss-research-chat-');
  fs.mkdirSync(path.join(dir, 'codex-home'));
  fs.writeFileSync(path.join(dir, 'codex-home', 'config.toml'), mockProviderToml(baseUrl ?? mock.baseUrl, 'gpt-mock'));
  const reads: string[] = [];
  const writes: string[] = [];
  const forbidden = (name: string) => async (): Promise<never> => { writes.push(name); throw new Error('不能联系'); };
  const site: Site = {
    open: async () => ({ page: 'ready', url: null }), status: async () => ({ page: 'ready', url: null }), close: async () => {},
    search: async q => { reads.push(`search:${q.keyword}:${q.city}:${q.page}`); return q.page === 1 ? [job(`${q.keyword}-1`), job(`${q.keyword}-2`, '30-40K')] : []; },
    jobDetail: async card => { reads.push(`detail:${card.jobId}`); return `实际JD-${card.jobId}：Python与Agent开发`; },
    openJob: forbidden('openJob'), contact: forbidden('contact'), readChat: forbidden('readChat'), sendGreeting: forbidden('sendGreeting'),
  };
  const server = await startServer({ dataDir: dir, port: 0, site });
  await api(server.url, 'PUT', '/api/inputs', inputs);
  return { mock, dir, server, site, reads, writes };
}

function waitState(server: RunningServer, predicate: (s: AppState) => boolean): Promise<AppState> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); server.app.off('changed', check); };
    const check = () => void server.app.getState().then(state => { if (predicate(state)) { cleanup(); resolve(state); } }, error => { cleanup(); reject(error); });
    const timer = setTimeout(() => { cleanup(); reject(new Error('状态未达到预期')); }, 10_000);
    server.app.on('changed', check);
    check();
  });
}

test('调研逐方向保存并排序：实际JD、程序薪资、独立模型上下文、重启保留', async () => {
  const script = [researchAction, end, plan, end, evaluation('low'), end, evaluation('high'), end, evaluation('medium'), end, evaluation('high'), end, evaluation('low'), end];
  const { mock, dir, server, reads, writes } = await fixture(script);
  let closed = false;
  const progress: number[] = [];
  let updates = Promise.resolve();
  const observe = () => { updates = updates.then(async () => { const s = await server.app.getState(); if (s.research) progress.push(s.research.directions.length); }); };
  server.app.on('changed', observe);
  try {
    const started = await api<AppState>(server.url, 'POST', '/api/chat', { message: '调研北京方向' });
    assert.equal(started.status, 200);
    const state = await waitState(server, s => !s.chat.pending && s.research.status === 'idle');
    assert.deepEqual(state.supportedCities, SUPPORTED_CITIES);
    assert.deepEqual(state.research.directions.map(d => d.fit), ['high', 'high', 'medium', 'low', 'low']);
    assert.ok(progress.includes(1) && progress.includes(4), '完成一个方向即可观察，不等整轮结束');
    for (const direction of state.research.directions) {
      assert.equal(direction.sampled, 2);
      assert.equal(direction.matched, 2);
      assert.equal(direction.salaryRange, '20-40K');
    }
    assert.equal(reads.filter(s => s.startsWith('detail:')).length, 10);
    assert.deepEqual(writes, []);
    for (let i = 4; i < mock.requests.length; i += 2) {
      const text = JSON.stringify(mock.requests[i]?.input);
      const sampledNames = names.filter(name => text.includes(`实际JD-${name}-`));
      assert.equal(sampledNames.length, 1, '判定回合只包含当前方向的实际JD');
    }
    server.app.off('changed', observe);
    await updates;
    await server.close(); closed = true;
    const recovered = openState(path.join(dir, 'state.sqlite'));
    assert.deepEqual(recovered.snapshot().research, state.research);
    recovered.close();
  } finally { server.app.off('changed', observe); await updates; if (!closed) await server.close(); mock.close(); }
});

for (const ending of ['stop', 'blocked'] as const) test(`调研${ending}保留已完成方向且等待在途读取`, async () => {
  const { mock, server, site, writes } = await fixture([researchAction, end, plan, end, evaluation('high'), end]);
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let entered!: () => void;
  const pending = new Promise<void>(r => { entered = r; });
  const original = site.search;
  site.search = async q => {
    if (q.keyword === names[1]) { entered(); await gate; if (ending === 'blocked') throw new SiteBlockedError({ page: 'verify', url: null }); }
    return original(q);
  };
  try {
    assert.equal((await api(server.url, 'POST', '/api/chat', { message: '调研北京方向' })).status, 200);
    await pending;
    const partial = (await api<AppState>(server.url, 'GET', '/api/state')).json;
    assert.equal(partial.research.directions.length, 1);
    for (const [method, endpoint, body] of [
      ['POST', '/api/chat', { message: '开始投递' }], ['POST', '/api/chat', { message: '建议？' }], ['POST', '/api/chat', { message: '调研北京方向' }],
      ['POST', '/api/batch/start', undefined], ['PUT', '/api/inputs', inputs], ['POST', '/api/chat/clear', undefined],
    ] as const) assert.equal((await api(server.url, method, endpoint, body)).status, 409, endpoint);
    if (ending === 'stop') {
      const stopped = await api<AppState>(server.url, 'POST', '/api/research/stop');
      assert.equal(stopped.json.research.status, 'stopping');
      assert.equal(stopped.json.research.finishedAt, null);
    }
    const finished = waitState(server, s => !s.chat.pending && s.research.status === 'idle');
    release();
    const state = await finished;
    assert.deepEqual(state.research.directions, partial.research.directions);
    assert.match(state.research.message!, ending === 'stop' ? /停止/ : /验证/);
    assert.ok(state.research.finishedAt);
    assert.deepEqual(writes, []);
  } finally { release(); await server.close(); mock.close(); }
});

test('调研采样上限、去重、排除已联系；无JD不编造匹配度和薪资', async () => {
  const script = [researchAction, end, plan, end, evaluation('high', 10), end];
  const { mock, dir, server, site, writes } = await fixture(script);
  const read: string[] = [];
  site.search = async q => q.keyword === names[0] ? [job('contacted'), ...Array.from({ length: 20 }, (_, i) => job(`j${i}`)), job('j1')] : [];
  site.jobDetail = async card => { read.push(card.jobId); return '实际JD'; };
  // 先通过账本持久化已联系事实，再让应用打开同一数据库。
  await server.close();
  const state = openState(path.join(dir, 'state.sqlite'));
  const batch = state.replaceBatch([{ ...job('contacted'), reason: '旧记录', greeting: '你好' }]);
  state.setStep(batch.targets[0]!, 'contact', 'done', '已联系');
  state.close();
  const restarted = await startServer({ dataDir: dir, port: 0, site });
  try {
    assert.equal((await api(restarted.url, 'POST', '/api/chat', { message: '调研北京方向' })).status, 200);
    const result = await waitState(restarted, s => !s.chat.pending && s.research.status === 'idle');
    assert.equal(read.length, RESEARCH_SAMPLE_PER_DIRECTION);
    assert.ok(!read.includes('contacted'));
    assert.equal(new Set(read).size, read.length);
    assert.equal(result.research.directions.length, 5);
    for (const direction of result.research.directions.filter(d => d.sampled === 0)) {
      assert.equal(direction.fit, 'low'); assert.equal(direction.matched, 0); assert.equal(direction.salaryRange, '');
    }
    assert.deepEqual(writes, []);
  } finally { await restarted.close(); mock.close(); }
});

test('对话立即pending，仅reply工具；消息持久化、限长、clear及后台错误复位', async () => {
  const { mock, dir, server, reads, writes } = await fixture([reply('建议先补充Agent项目量化成果'), end, end]);
  let closed = false;
  try {
    for (const message of ['', ' ', '字'.repeat(CHAT_MESSAGE_MAX_CHARS + 1)]) assert.equal((await api(server.url, 'POST', '/api/chat', { message })).status, 400);
    const posted = await api<AppState>(server.url, 'POST', '/api/chat', { message: '如何优化简历？' });
    assert.equal(posted.status, 200);
    assert.equal(posted.json.chat.pending, true);
    const state = await waitState(server, s => !s.chat.pending);
    assert.deepEqual(state.chat.messages.map(m => [m.role, m.text]), [['user', '如何优化简历？'], ['assistant', '建议先补充Agent项目量化成果']]);
    const text = JSON.stringify(mock.requests[0]?.input);
    assert.match(text, /Python后端、Agent项目/);
    assert.match(text, /希望探索AI方向/);
    assert.match(JSON.stringify(mock.requests[0]?.tools), /reply/);
    for (const name of ['boss_search', 'propose_batch', 'submit_decisions', 'exec_command', 'web_search']) assert.ok(!JSON.stringify(mock.requests[0]?.tools).includes(name));
    assert.deepEqual(reads, []); assert.deepEqual(writes, []);
    assert.equal((await api(server.url, 'POST', '/api/chat', { message: '再建议一下' })).status, 200);
    const failed = await waitState(server, s => !s.chat.pending);
    assert.match(failed.chat.messages.at(-1)!.text, /失败|未.*回复/);
    await server.close(); closed = true;
    const db = openState(path.join(dir, 'state.sqlite'));
    assert.deepEqual(db.snapshot().chat, failed.chat);
    db.close();
    const restarted = await startServer({ dataDir: dir, port: 0 });
    try { assert.deepEqual((await api<AppState>(restarted.url, 'POST', '/api/chat/clear')).json.chat, { pending: false, messages: [] }); }
    finally { await restarted.close(); }
  } finally { if (!closed) await server.close(); mock.close(); }
});

test('SQLite恢复调研/对话中断，保留已完成方向并限制历史消息数', () => {
  const file = path.join(tempDir('boss-assist-state-'), 'state.sqlite');
  let state = openState(file);
  state.saveInputs(inputs);
  state.beginResearch('北京');
  const direction = { name: 'Agent', keywords: ['Agent'], fit: 'high' as const, reason: '匹配', gaps: '规模', salaryRange: '20-40K', sampled: 2, matched: 1 };
  state.addResearchDirection(direction);
  state.close();
  state = openState(file);
  assert.equal(state.snapshot().research.status, 'idle');
  assert.match(state.snapshot().research.message!, /中断/);
  assert.deepEqual(state.snapshot().research.directions, [direction]);
  for (let i = 0; i < CHAT_HISTORY_LIMIT; i++) { state.beginChat(`问题${i}`); state.finishChat(`答复${i}`); }
  assert.equal(state.snapshot().chat.messages.length, CHAT_HISTORY_LIMIT);
  state.beginChat('中断前的问题');
  state.close();
  state = openState(file);
  assert.equal(state.snapshot().chat.pending, false);
  assert.match(state.snapshot().chat.messages.at(-1)!.text, /中断/);
  assert.equal(state.snapshot().chat.messages.length, CHAT_HISTORY_LIMIT);
  state.close();
});


test('对话pending期间与发现、调研、投递和clear互斥，超长模型回复作为失败处理', async () => {
  const model = await startMockModel([reply('字'.repeat(CHAT_MESSAGE_MAX_CHARS + 1)), end]);
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const proxy = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { void gate.then(() => fetch(`${model.baseUrl}/responses`, { method: 'POST', body }))
      .then(async response => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(await response.text()); }).catch(error => res.destroy(error)); });
  });
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/v1`;
  const { mock, server, writes } = await fixture([], base);
  try {
    const posted = await api<AppState>(server.url, 'POST', '/api/chat', { message: '建议？' });
    assert.equal(posted.status, 200);
    assert.equal(posted.json.chat.pending, true);
    for (const [endpoint, body] of [
      ['/api/chat', { message: '调研北京方向' }], ['/api/chat', { message: '北京前端，薪资不限，投递10个' }], ['/api/batch/start', undefined], ['/api/chat', { message: '再次' }], ['/api/chat/clear', undefined],
    ] as const) assert.equal((await api(server.url, 'POST', endpoint, body)).status, 409, endpoint);
    release();
    const state = await waitState(server, s => !s.chat.pending);
    assert.match(state.chat.messages.at(-1)!.text, /失败|回复/);
    assert.ok(state.chat.messages.at(-1)!.text.length <= CHAT_MESSAGE_MAX_CHARS);
    assert.deepEqual(writes, []);
  } finally { release(); await server.close(); mock.close(); model.close(); proxy.closeAllConnections(); await new Promise<void>(r => proxy.close(() => r())); }
});

for (const invalid of ['directions', 'matched'] as const) test(`拒绝模型无效调研结果：${invalid}`, async () => {
  const script = invalid === 'directions' ? [researchAction, end, call('suggest_directions', { directions: [{ name: 'AI', keywords: ['AI'] }] }), end]
    : [researchAction, end, plan, end, evaluation('high', 99), end];
  const { mock, server, reads, writes } = await fixture(script);
  try {
    assert.equal((await api(server.url, 'POST', '/api/research/start', { city: '北京' })).status, 404);
    assert.equal((await api(server.url, 'POST', '/api/chat', { message: '调研北京方向' })).status, 200);
    const state = await waitState(server, s => !s.chat.pending && s.research.status === 'idle');
    assert.equal(state.research.directions.length, 0);
    assert.match(state.research.message!, /失败|无效/);
    if (invalid === 'directions') assert.deepEqual(reads, []);
    assert.deepEqual(writes, []);
  } finally { await server.close(); mock.close(); }
});
