import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openState } from '../src/state.ts';
import { startServer } from '../src/server.ts';
import type { Site } from '../src/boss.ts';
import type { AppState } from '../src/contracts.ts';
import { countedSite, instantReadClock, tempDir, api } from './helpers.ts';
import { startMockModel, mockProviderToml, type MockItem } from './mock-responses.ts';

test('日剩余额度不足时按方向配额缩小预算，不能让首方向吃掉全部余额', async () => {
  const message = '深圳AI开发100个、后端50个，薪资不限，只找不投';
  const end: MockItem[] = [{ type: 'message', text: '完成' }];
  const reject = (ids: string[]): MockItem[] => [{ type: 'function_call', name: 'submit_decisions', args: { decisions: ids.map(jobId => ({ jobId, decision: 'reject', reason: '主要职责是销售，不属于计划方向', rejectionCategory: '岗位方向不符' })) } }];
  const mock = await startMockModel([
    [{ type: 'function_call', name: 'start_delivery', args: { city: '深圳', salaryMinK: null, criteria: 'AI或后端开发', sendNow: false, quote: message, directions: [{ name: 'AI开发', keywords: ['AI'], count: 100 }, { name: '后端', keywords: ['后端'], count: 50 }] } }], end,
    reject(Array.from({ length: 10 }, (_, i) => `AI${i}`)), end,
    reject(Array.from({ length: 10 }, (_, i) => `AI${i + 10}`)), end,
    reject(Array.from({ length: 10 }, (_, i) => `后端${i}`)), end,
  ]);
  const dir = tempDir('boss-daily-direction-');
  fs.mkdirSync(path.join(dir, 'codex-home'));
  fs.writeFileSync(path.join(dir, 'codex-home', 'config.toml'), mockProviderToml(mock.baseUrl, 'gpt-mock'));
  const db = openState(path.join(dir, 'state.sqlite'));
  db.saveInputs({ greeting: '您好', requirements: '', resume: { text: 'Python经验' } });
  for (let i = 0; i < 270; i++) db.recordJobRead();
  db.close();
  const reads: string[] = [];
  const forbidden = async (): Promise<never> => { throw new Error('只找不投'); };
  const site: Site = {
    open: async () => ({ page: 'ready', url: null }), status: async () => ({ page: 'ready', url: null }), close: async () => {},
    search: async q => Array.from({ length: 40 }, (_, i) => ({ jobId: `${q.keyword}${i}`, url: `https://www.zhipin.com/job_detail/${q.keyword}${i}.html`, company: '测试', title: '销售', salary: '20-40K', area: '深圳', snippet: '' })),
    jobDetail: async c => { reads.push(c.jobId); return '主要职责是销售'; },
    openJob: forbidden, contact: forbidden, readChat: forbidden, sendGreeting: forbidden,
  };
  const server = await startServer({ dataDir: dir, port: 0, site: countedSite(site), readClock: instantReadClock });
  try {
    await api(server.url, 'POST', '/api/chat', { message });
    const state = await new Promise<AppState>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); server.app.off('changed', check); };
      const check = () => void server.app.getState().then(s => { if (!s.chat.pending && s.discovery.status === 'idle') { cleanup(); resolve(s); } }, e => { cleanup(); reject(e); });
      const timer = setTimeout(() => { cleanup(); reject(new Error('任务未结束')); }, 10_000);
      server.app.on('changed', check); check();
    });
    assert.deepEqual(reads, [...Array.from({ length: 20 }, (_, i) => `AI${i}`), ...Array.from({ length: 10 }, (_, i) => `后端${i}`)]);
    assert.equal(state.jobReadsToday, 300);
    assert.match(state.discovery.message!, /今日浏览上限已到，明天继续/);
    assert.match(state.discovery.message!, /AI开发.*读取 20\/20/);
    assert.match(state.discovery.message!, /后端.*读取 10\/10/);
  } finally { await server.close(); mock.close(); }
});
