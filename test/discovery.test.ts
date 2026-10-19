import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/server.ts';
import type { Site } from '../src/boss.ts';
import type { AppState } from '../src/contracts.ts';
import { api, LOCAL, tempDir } from './helpers.ts';
import { mockProviderToml, startMockModel, type MockItem } from './mock-responses.ts';

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
    sendResume: refuse('sendResume'),
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
  await api(server.url, 'PUT', '/api/resume/text', { text: '张三，五年前端经验，React/TypeScript', confirmed: true });
  await api(server.url, 'PUT', '/api/criteria', { keywords: ['前端'], city: '北京', salaryMinK: 20, maxTargets: 5, excludeCompanies: [] });
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
      [{ type: 'function_call', name: 'boss_search', args: { keyword: '前端', page: 1 } }],
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
      [{ jobId: 'j1', company: '甲公司', title: '前端工程师', salary: '25-35K', greeting: '您好，我有五年 React 经验', steps: { contact: 'todo', greeting: 'todo', resume: 'todo' } }],
    );
    const rejectedOutput = JSON.stringify(mock.requests[3]?.input.at(-1));
    assert.match(rejectedOutput, /zzz/, '编造的岗位被工具拒绝并告知模型');
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
