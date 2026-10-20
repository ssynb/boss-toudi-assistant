import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  [{ type: 'function_call', name: 'boss_search', args: { keyword: '前端', page: 1 } }],
  [{ type: 'function_call', name: 'boss_job_detail', args: { jobId: 'j1' } }],
  [{ type: 'function_call', name: 'propose_batch', args: { targets: [{ jobId: 'j1', reason: 'React 匹配', greeting: '您好，我有五年 React 经验' }] } }],
  [{ type: 'message', text: '已提交' }],
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
    search: async () => { calls.push('search'); return [card]; },
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
  assert.deepEqual(calls, ['search', 'open', 'contact', 'greet:您好，我有五年 React 经验']);
  assert.equal(state.batch!.status, 'done');
  assert.equal(state.discovery.autoSend, true);
});

test('未选自动投递时只生成待审草案，不联系任何人', { timeout: 60_000 }, async () => {
  const { state, calls } = await run({ autoSend: false });
  assert.deepEqual(calls, ['search']);
  assert.equal(state.batch!.status, 'draft');
});

test('浏览器窗口被关闭时发现照常搜索（由搜索重新打开浏览器）', { timeout: 60_000 }, async () => {
  const { calls } = await run(undefined, 'closed');
  assert.deepEqual(calls, ['search']);
});
