import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/server.ts';
import { MAX_SEARCH_PAGE, SiteBlockedError, type Site } from '../src/boss.ts';
import type { AppState } from '../src/contracts.ts';
import { api, LOCAL, tempDir } from './helpers.ts';
import { mockProviderToml, startMockModel, type MockItem } from './mock-responses.ts';

const plan: MockItem = { type: 'function_call', name: 'set_search_plan', args: {
  keywords: ['前端'], city: '北京', salaryMinK: 20, maxTargets: 1, excludeCompanies: ['乙公司'],
  quotes: { direction: '前端', city: '北京', salary: '月薪至少20K' },
} };
const cards = [
  { jobId: 'j1', url: 'https://www.zhipin.com/job_detail/j1.html', title: '前端工程师', company: '甲公司', salary: '25-35K', area: '北京·朝阳', snippet: '3-5年 本科 React' },
  { jobId: 'j2', url: 'https://www.zhipin.com/job_detail/j2.html', title: 'Java 开发', company: '乙公司', salary: '15-20K', area: '北京·海淀', snippet: '1-3年' },
];

function fakeSite() {
  const writes: string[] = [];
  const reads: string[] = [];
  const refuse = (name: string) => async () => {
    writes.push(name);
    throw new Error(`发现阶段不允许调用 ${name}`);
  };
  const site: Site = {
    open: async () => ({ page: 'ready', url: 'https://www.zhipin.com/' }),
    status: async () => ({ page: 'ready', url: 'https://www.zhipin.com/' }),
    close: async () => {},
    search: async (q) => {
      reads.push(`search:${q.keyword}:${q.city}:${q.page}`);
      return cards;
    },
    jobDetail: async (c) => {
      reads.push(`detail:${c.jobId}`);
      return '岗位职责：负责前端开发';
    },
    openJob: refuse('openJob'),
    contact: refuse('contact'),
    readChat: refuse('readChat'),
    sendGreeting: refuse('sendGreeting'),
  };
  return { site, writes, reads };
}

async function setup(script: MockItem[][], model: string) {
  const mock = await startMockModel(script);
  const dataDir = tempDir('boss-discovery-');
  fs.mkdirSync(path.join(dataDir, 'codex-home'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'codex-home', 'config.toml'), mockProviderToml(mock.baseUrl, model));
  const fake = fakeSite();
  const server = await startServer({ dataDir, port: 0, site: fake.site });
  const saved = await api(server.url, 'PUT', '/api/inputs', { requirements: '北京前端，月薪至少20K，最多1个，不考虑乙公司', resume: { text: '张三，五年前端经验，React/TypeScript' } });
  assert.equal(saved.status, 200);
  return { mock, dataDir, fake, server };
}

/** 订阅事件流，直到发现任务结束。 */
async function discover(base: string): Promise<AppState> {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: LOCAL, signal: controller.signal });
  const reader = res.body!.getReader();
  const started = await api<AppState>(base, 'POST', '/api/discovery/start');
  assert.equal(started.status, 200, JSON.stringify(started.json));
  const deadline = Date.now() + 60_000;
  try {
    while (Date.now() < deadline) {
      const { done } = await reader.read();
      if (done) break;
      const state = (await api<AppState>(base, 'GET', '/api/state')).json;
      if (state.discovery.status === 'idle') return state;
    }
    throw new Error('发现任务未结束');
  } finally {
    controller.abort();
  }
}

const end: MockItem[] = [{ type: 'message', text: '完成本轮' }];
const selection = (jobId: string, selected = true) => ({ jobId, decision: selected ? 'select' : 'reject', reason: selected ? 'React经验匹配实际JD' : '实际JD与简历不匹配', ...(selected ? { greeting: '您好，我有五年 React 经验' } : {}) });
const judgments = (items: ReturnType<typeof selection>[]): MockItem[] => [{ type: 'function_call', name: 'submit_decisions', args: { decisions: items } }];
const planned = (maxTargets: number, keywords = ['前端']): MockItem[] => [{ type: 'function_call', name: 'set_search_plan', args: { ...(plan as Extract<MockItem, { type: 'function_call' }>).args as object, maxTargets, keywords } }];

// 模型替身只给计划和本批判断，不替程序搜索、读取或累计。
function scriptFor(ids: string[], maxTargets: number, select: (id: string) => boolean = () => true): MockItem[][] {
  const script: MockItem[][] = [planned(maxTargets), end];
  for (let i = 0; i < ids.length; i += 10) script.push(judgments(ids.slice(i, i + 10).map(id => selection(id, select(id)))), end);
  return script;
}

const job = (id: string) => ({ ...cards[0]!, jobId: id, url: `https://www.zhipin.com/job_detail/${id}.html` });

test('程序搜索、排除、读取实际JD后由独立模型回合判定，只有正常结束保存草案', async () => {
  const { mock, fake, server } = await setup([planned(1), end, judgments([selection('j1')]), end], 'gpt-mock');
  try {
    const state = await discover(server.url);
    assert.deepEqual(fake.writes, []);
    assert.deepEqual(fake.reads, ['search:前端:北京:1', 'detail:j1']);
    assert.equal(state.batch!.status, 'draft');
    assert.deepEqual(state.batch!.targets.map(t => ({ jobId: t.jobId, company: t.company, greeting: t.greeting, steps: t.steps })),
      [{ jobId: 'j1', company: '甲公司', greeting: '您好，我有五年 React 经验', steps: { contact: 'todo', greeting: 'todo' } }]);
    const input = JSON.stringify(mock.requests[2]);
    assert.match(input, /岗位职责：负责前端开发/);
    const user = mock.requests[2]!.input.filter(item => (item as { role?: string }).role === 'user').at(-1) as { content: { text: string }[] };
    const jobs = JSON.parse(user.content[0]!.text).jobs as { card: { company: string } }[];
    assert.ok(jobs.length > 0);
    assert.ok(jobs.every(({ card }) => card.company !== '乙公司'), '排除公司不能进入本批岗位数据');
    for (const request of mock.requests) {
      const tools = JSON.stringify(request.tools);
      for (const name of ['boss_search', 'boss_job_detail', 'propose_batch']) assert.ok(!tools.includes(name), '模型不能驱动浏览器或提交整轮草案');
    }
  } finally { await server.close(); mock.close(); }
});

test('模型看不到 shell、联网搜索等工具；越权的命令与改文件被拒绝', async () => {
  const attack = [
    'const out = {};',
    "try { out.exec = await tools.exec_command({ cmd: 'echo x > pwned.txt' }); } catch (e) { out.exec = String(e); }",
    "try { out.patch = await tools.apply_patch('*** Begin Patch\\n*** Add File: pwned.txt\\n+x\\n*** End Patch\\n'); } catch (e) { out.patch = String(e); }",
    'text(JSON.stringify(out));',
  ].join('\n');
  const { mock, dataDir, fake, server } = await setup([[{ type: 'exec', js: attack }], [{ type: 'message', text: '结束' }]], 'gpt-6.1-sol');
  try {
    const state = await discover(server.url);
    assert.equal(state.batch, null);
    assert.deepEqual(fake.writes, []);

    const visible = JSON.stringify(mock.requests[0]);
    for (const name of ['exec_command', 'write_stdin', 'web_search', 'view_image', 'image_generation']) {
      assert.ok(!visible.includes(`"${name}"`) && !visible.includes(`\`${name}\``), `模型不应看到 ${name}`);
    }
    const result = JSON.stringify(mock.requests[1]?.input.at(-1));
    assert.match(result, /exec_command is not a function/);
    assert.match(result, /rejected/);

    const leaked: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(dir, e.name));
        else if (e.name === 'pwned.txt') leaked.push(path.join(dir, e.name));
      }
    };
    walk(dataDir);
    assert.deepEqual(leaked, []);
  } finally {
    await server.close();
    mock.close();
  }
});


test('缺关键要求先澄清，不搜索；补充同一文本框后清除问题', async () => {
  const { mock, fake, server } = await setup([
    [{ type: 'function_call', name: 'request_clarification', args: { questions: ['希望在哪个城市？', '可接受的最低月薪或不限？'] } }],
    [{ type: 'message', text: '请补充' }],
  ], 'gpt-mock');
  try {
    await api(server.url, 'PUT', '/api/inputs', { requirements: '前端', resume: { text: null } });
    const state = await discover(server.url);
    assert.deepEqual(state.discovery.questions, ['希望在哪个城市？', '可接受的最低月薪或不限？']);
    assert.deepEqual(fake.reads, []);
    assert.deepEqual(fake.writes, []);
    assert.equal(state.batch, null);
    const saved = await api<AppState>(server.url, 'PUT', '/api/inputs', { requirements: '北京前端，薪资不限', resume: { text: null } });
    assert.equal(saved.json.requirements, '北京前端，薪资不限');
    assert.deepEqual(saved.json.discovery.questions, []);
    for (const endpoint of ['profile', 'criteria']) assert.equal((await api(server.url, 'PUT', '/api/' + endpoint, {})).status, 404);
    assert.ok(!('profile' in saved.json) && !('criteria' in saved.json));
  } finally { await server.close(); mock.close(); }
});


for (const count of [100, 289, 700]) test(`程序累计判定并正常保存，候选${count}`, { timeout: 60_000 }, async () => {
  const readLimit = Math.min(count, 600);
  const ids = Array.from({ length: readLimit }, (_, i) => `j${i}`);
  const select = (id: string) => count === 100 || Number(id.slice(1)) % 10 === 0;
  const { mock, fake, server } = await setup(scriptFor(ids, 100, select), 'gpt-mock');
  const searched: number[] = [];
  const read: string[] = [];
  fake.site.search = async q => { searched.push(q.page); return q.page === 1 ? Array.from({ length: count }, (_, i) => job(`j${i}`)) : []; };
  fake.site.jobDetail = async c => { read.push(c.jobId); return `真实JD-${c.jobId}-END`; };
  try {
    await api(server.url, 'PUT', '/api/inputs', { requirements: '北京前端，月薪至少20K，目标100个', resume: { text: null } });
    const state = await discover(server.url);
    assert.equal(state.batch?.targets.length, count === 100 ? 100 : count === 289 ? 29 : 60);
    assert.equal(read.length, readLimit, '100目标允许最多600次详情读取，不能在147次后由模型结束');
    assert.deepEqual(searched, count === 289 ? [1, 2] : [1], '达到目标或预算后不再搜索');
    if (count !== 100) assert.match(state.discovery.message!, count === 289 ? /计划范围.*不代表全站/ : /详情.*预算/);
    for (const request of mock.requests.filter(r => JSON.stringify(r.input).includes('真实JD-'))) {
      const text = JSON.stringify(request.input);
      const unique = new Set(text.match(/真实JD-j\d+-END/g));
      assert.ok(unique.size <= 10, '独立判定回合不能累积旧批JD上下文');
    }
    assert.deepEqual(fake.writes, []);
  } finally { await server.close(); mock.close(); }
});

test('程序连续遍历计划关键词与页码，跨页去重；空JD不送给模型', async () => {
  const script: MockItem[][] = [planned(100, ['前端', 'React']), end];
  for (let page = 1; page <= MAX_SEARCH_PAGE; page++) script.push(judgments([selection(`p${page}`)]), end);
  script.push(judgments([selection('react')]), end);
  const { mock, fake, server } = await setup(script, 'gpt-mock');
  const searched: string[] = [];
  const read: string[] = [];
  fake.site.search = async q => {
    searched.push(`${q.keyword}:${q.page}`);
    if (q.keyword === 'React') return q.page === 1 ? [job('p1'), job('react')] : [];
    return [job(`p${q.page}`), job('empty'), cards[1]!];
  };
  fake.site.jobDetail = async c => { read.push(c.jobId); return c.jobId === 'empty' ? '' : `JD-${c.jobId}`; };
  try {
    const state = await discover(server.url);
    assert.equal(state.batch?.targets.length, MAX_SEARCH_PAGE + 1);
    assert.deepEqual(searched, [...Array.from({ length: MAX_SEARCH_PAGE }, (_, i) => `前端:${i + 1}`), 'React:1', 'React:2']);
    assert.equal(read.filter(id => id === 'empty').length, 1);
    assert.equal(read.filter(id => id === 'p1').length, 1);
    assert.ok(!read.includes('j2'), '排除公司不读JD');
    assert.ok(!state.batch!.targets.some(t => t.jobId === 'empty'), '空JD不能入选');
  } finally { await server.close(); mock.close(); }
});

for (const invalid of ['foreign', 'missing', 'duplicate', 'greeting'] as const) test(`本批判断校验失败后仅重试本批一次：${invalid}`, async () => {
  const valid = selection('j1');
  const bad = invalid === 'foreign' ? [selection('invented')] : invalid === 'missing' ? []
    : invalid === 'duplicate' ? [valid, valid] : [{ ...valid, greeting: '长'.repeat(201) }];
  const { mock, fake, server } = await setup([planned(1), end, judgments(bad), end, judgments([valid]), end], 'gpt-mock');
  try {
    const state = await discover(server.url);
    assert.equal(state.batch?.targets.length, 1);
    assert.match(JSON.stringify(mock.requests[3]?.input.at(-1)), /出错|无效|拒绝|200/);
    assert.deepEqual(fake.reads, ['search:前端:北京:1', 'detail:j1'], '重试判定不重读页面');
    assert.deepEqual(fake.writes, []);
  } finally { await server.close(); mock.close(); }
});

test('已有入选后遇到站点风控，整轮不保存不联系', async () => {
  const { mock, fake, server } = await setup([planned(100), end, judgments([selection('j1')]), end], 'gpt-mock');
  fake.site.search = async q => { if (q.page === 2) throw new SiteBlockedError({ page: 'verify', url: null }); return [job('j1')]; };
  try {
    const state = await discover(server.url);
    assert.equal(state.batch, null);
    assert.match(state.discovery.message!, /验证|风控/);
    assert.deepEqual(fake.writes, []);
  } finally { await server.close(); mock.close(); }
});
