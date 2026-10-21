import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startServer } from '../src/server.ts';
import type { Site } from '../src/boss.ts';
import type { AppState, BrowserPage } from '../src/contracts.ts';
import { api, LOCAL, tempDir } from './helpers.ts';
import { mockProviderToml, startMockModel, type MockItem } from './mock-responses.ts';

const plan: MockItem = { type: 'function_call', name: 'set_search_plan', args: {
  keywords: ['前端'], city: '北京', salaryMinK: null, maxTargets: 150, excludeCompanies: [],
  quotes: { direction: '前端', city: '北京', salary: '薪资不限' },
} };
const card = { jobId: 'j1', url: 'https://www.zhipin.com/job_detail/j1.html', title: '前端工程师', company: '甲公司', salary: '25-35K', area: '北京', snippet: 'React' };
const script: MockItem[][] = [
  [plan],
  [{ type: 'message', text: '计划完成' }],
  [{ type: 'function_call', name: 'submit_decisions', args: { decisions: [{ jobId: 'j1', decision: 'select', reason: 'React 匹配', greeting: '您好，我有五年 React 经验' }] } }],
  [{ type: 'message', text: '判定完成' }],
];

async function run(body: unknown, page: BrowserPage = 'ready') {
  const mock = await startMockModel(script);
  const dataDir = tempDir('boss-auto-');
  fs.mkdirSync(path.join(dataDir, 'codex-home'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'codex-home', 'config.toml'), mockProviderToml(mock.baseUrl, 'gpt-mock'));
  const calls: string[] = [];
  const site: Site = {
    open: async () => ({ page: 'ready', url: 'https://www.zhipin.com/' }),
    status: async () => ({ page, url: null }),
    close: async () => {},
    search: async q => { calls.push('search'); return q.page === 1 ? [card] : []; },
    jobDetail: async () => '岗位职责：前端开发',
    openJob: async () => { calls.push('open'); return { kind: 'canContact', evidence: '' }; },
    contact: async (t) => { calls.push('contact'); return { ok: true, evidence: '', identity: { jobId: t.jobId, recruiterUrl: 'https://www.zhipin.com/boss_detail/hr.html' } }; },
    readChat: async () => ({ ourMessages: 0, evidence: '' }),
    sendGreeting: async (_t, text) => { calls.push(`greet:${text}`); return { ok: true, evidence: '' }; },
  };
  const server = await startServer({ dataDir, port: 0, site });
  try {
    await api(server.url, 'PUT', '/api/inputs', { requirements: '北京前端，薪资不限，找 150 个', resume: { text: '五年 React 经验' } });
    const controller = new AbortController();
    const reader = (await fetch(`${server.url}/api/events`, { headers: LOCAL, signal: controller.signal })).body!.getReader();
    const started = await api<AppState>(server.url, 'POST', '/api/discovery/start', body);
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const finished = (s: AppState) => s.discovery.status === 'idle' && (body === undefined || !(body as { autoSend: boolean }).autoSend || ['done', 'paused'].includes(s.batch?.status ?? ''));
    try {
      for (;;) {
        const { done } = await reader.read();
        const state = (await api<AppState>(server.url, 'GET', '/api/state')).json;
        if (finished(state) || done) return { state, calls };
      }
    } finally { controller.abort(); }
  } finally { await server.close(); mock.close(); }
}

test('自动投递：一次开始即批准 AI 草案并执行联系与招呼', { timeout: 60_000 }, async () => {
  const { state, calls } = await run({ autoSend: true });
  assert.deepEqual(calls, ['search', 'search', 'open', 'contact', 'greet:您好，我有五年 React 经验']);
  assert.equal(state.batch!.status, 'done');
  assert.equal(state.discovery.autoSend, true);
});

test('未选自动投递时只生成待审草案，不联系任何人', { timeout: 60_000 }, async () => {
  const { state, calls } = await run({ autoSend: false });
  assert.deepEqual(calls, ['search', 'search']);
  assert.equal(state.batch!.status, 'draft');
});

test('浏览器窗口被关闭时发现照常搜索（由搜索重新打开浏览器）', { timeout: 60_000 }, async () => {
  const { calls } = await run(undefined, 'closed');
  assert.deepEqual(calls, ['search', 'search']);
});

for (const terminal of ['failed', 'cancelled'] as const) {
  test(`自动投递草案暂存后${terminal}：保留原批次且不联系`, { timeout: 30_000 }, async () => {
    const mock = await startMockModel([...script, ...script]);
    let respond!: (res: http.ServerResponse) => void;
    const staged = new Promise<http.ServerResponse>(resolve => { respond = resolve; });
    let requests = 0;
    let lastInput = '';
    const provider = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        if (++requests >= 8) {
          lastInput = JSON.stringify(JSON.parse(body).input.at(-1));
          if (requests === 8) respond(res);
          else {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end(`event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response: { id: 'failure', error: { code: 'invalid_prompt', message: 'staged fixture failure' } } })}\n\n`);
          }
          return;
        }
        void fetch(`${mock.baseUrl}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
          .then(async upstream => { res.writeHead(upstream.status, { 'content-type': 'text/event-stream' }); res.end(await upstream.text()); })
          .catch(error => res.destroy(error));
      });
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const dir = tempDir('boss-staged-');
    fs.mkdirSync(path.join(dir, 'codex-home'));
    fs.writeFileSync(path.join(dir, 'codex-home', 'config.toml'), mockProviderToml(`http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`, 'gpt-mock'));
    const writes: string[] = [];
    const forbidden = (name: string) => async (): Promise<never> => { writes.push(name); throw new Error('不能联系'); };
    const site: Site = {
      open: async () => ({ page: 'ready', url: null }), status: async () => ({ page: 'ready', url: null }), close: async () => {},
      search: async q => q.page === 1 ? [card] : [], jobDetail: async () => '岗位职责：React前端开发',
      openJob: forbidden('openJob'), contact: forbidden('contact'), readChat: forbidden('readChat'), sendGreeting: forbidden('sendGreeting'),
    };
    const server = await startServer({ dataDir: dir, port: 0, site });
    const idle = () => new Promise<AppState>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); server.app.off('changed', check); };
      const check = () => void server.app.getState().then(state => {
        if (state.discovery.status === 'idle') { cleanup(); resolve(state); }
      }, error => { cleanup(); reject(error); });
      const timer = setTimeout(() => { cleanup(); reject(new Error('发现未结束')); }, 10_000);
      server.app.on('changed', check);
      check();
    });
    try {
      await api(server.url, 'PUT', '/api/inputs', { requirements: '北京前端，薪资不限，找150个', resume: { text: '五年React经验' } });
      await server.app.startDiscovery({ autoSend: false });
      const original = (await idle()).batch;
      assert.ok(original);
      await server.app.startDiscovery({ autoSend: true });
      const response = await staged;
      assert.match(lastInput, /判定已接收/, '终态发生在真实Codex收到草案接收结果后');
      const finished = idle();
      if (terminal === 'cancelled') server.app.stopDiscovery();
      else {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response: { id: 'failure', error: { code: 'invalid_prompt', message: 'staged fixture failure' } } })}\n\n`);
      }
      const state = await finished;
      assert.equal(state.discovery.autoSend, true);
      assert.match(state.discovery.message!, terminal === 'cancelled' ? /停止/ : /staged fixture failure/);
      assert.deepEqual(state.batch, original, '失败或取消不能替换原批次（含版本、批准状态和目标）');
      assert.deepEqual(writes, [], '不能批准或执行任何联系动作');
    } finally {
      await server.close();
      provider.closeAllConnections();
      await new Promise<void>(resolve => provider.close(() => resolve()));
      mock.close();
    }
  });
}
