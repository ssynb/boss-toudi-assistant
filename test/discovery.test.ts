import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/server.ts';
import type { Site } from '../src/boss.ts';
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

test('Codex 通过受限只读工具发现岗位，生成待批准草案，期间没有任何联系动作', async () => {
  const { mock, fake, server } = await setup(
    [
      [plan],
      [{ type: 'function_call', name: 'boss_search', args: { keyword: '前端', page: 1 } }],
      [{ type: 'function_call', name: 'propose_batch', args: { targets: [{ jobId: 'j1', reason: '只看标题', greeting: '你好' }] } }],
      [{ type: 'function_call', name: 'boss_job_detail', args: { jobId: 'j1' } }],
      [{ type: 'function_call', name: 'propose_batch', args: { targets: [{ jobId: 'zzz', reason: '编造的', greeting: '你好' }] } }],
      [{ type: 'function_call', name: 'propose_batch', args: { targets: [{ jobId: 'j1', reason: 'React 经验匹配', greeting: '您好，我有五年 React 经验' }] } }],
      [{ type: 'message', text: '已提交草案' }],
    ],
    'gpt-mock',
  );
  try {
    const state = await discover(server.url);
    assert.deepEqual(fake.writes, []);
    assert.deepEqual(fake.reads, ['search:前端:北京:1', 'detail:j1']);
    const batch = state.batch!;
    assert.equal(batch.status, 'draft');
    assert.deepEqual(
      batch.targets.map((t) => ({ jobId: t.jobId, company: t.company, title: t.title, salary: t.salary, greeting: t.greeting, steps: t.steps })),
      [{ jobId: 'j1', company: '甲公司', title: '前端工程师', salary: '25-35K', greeting: '您好，我有五年 React 经验', steps: { contact: 'todo', greeting: 'todo' } }],
    );
    const rejectedOutput = JSON.stringify(mock.requests[5]?.input.at(-1));
    assert.match(rejectedOutput, /zzz/, '编造的岗位被工具拒绝并告知模型');
    assert.match(JSON.stringify(mock.requests[3]?.input.at(-1)), /JD|详情/, '未读 JD 不能提交草案');
    assert.ok(!JSON.stringify(mock.requests[2]?.input.at(-1)).includes('乙公司'), '排除公司不交给模型候选集');
  } finally {
    await server.close();
    mock.close();
  }
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
    [{ type: 'function_call', name: 'boss_search', args: { keyword: '前端', page: 1 } }],
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

for (const exhausted of [false, true]) test(`100目标不能以4个无解释结束；搜索耗尽=${exhausted}`, async () => {
  const targets = Array.from({ length: 4 }, (_, i) => ({ jobId: `j${i}`, reason: '实际JD匹配React经验', greeting: '您好，我有React经验' }));
  const script: MockItem[][] = [
    [{ ...plan, args: { ...(plan as Extract<MockItem, { type: 'function_call' }>).args as object, maxTargets: 100 } } as MockItem],
    [{ type: 'function_call', name: 'boss_search', args: { keyword: '前端', page: 1 } }],
    ...targets.map(t => [{ type: 'function_call' as const, name: 'boss_job_detail', args: { jobId: t.jobId } }]),
    [{ type: 'function_call', name: 'propose_batch', args: { targets } }],
  ];
  if (exhausted) script.push(
    [{ type: 'function_call', name: 'boss_search', args: { keyword: '前端', page: 2 } }],
    [{ type: 'function_call', name: 'propose_batch', args: { targets, shortfallReason: '搜索结果已耗尽，仅4个岗位符合实际JD要求' } }],
  );
  script.push([{ type: 'message', text: '结束' }]);
  const { mock, fake, server } = await setup(script, 'gpt-mock');
  fake.site.search = async q => q.page === 1 ? targets.map(t => ({ ...cards[0]!, jobId: t.jobId })) : [];
  try {
    await api(server.url, 'PUT', '/api/inputs', { requirements: '北京前端，月薪至少20K，目标100个', resume: { text: null } });
    const state = await discover(server.url);
    assert.match(JSON.stringify(mock.requests[7]?.input.at(-1)), /100|继续/);
    assert.equal(state.batch?.targets.length ?? 0, exhausted ? 4 : 0);
    assert.ok(state.discovery.message);
    assert.match(state.discovery.message, exhausted ? /100.*4|4.*100/ : /未.*目标|没有提交/);
    if (exhausted) assert.match(state.discovery.message, /耗尽/);
    assert.deepEqual(fake.writes, []);
  } finally { await server.close(); mock.close(); }
});
