import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/server.ts';
import { openState } from '../src/state.ts';
import type { JobCard, Site } from '../src/boss.ts';
import type { AppState } from '../src/contracts.ts';
import { countedSite, instantReadClock, tempDir, api , type FakeSite } from './helpers.ts';
import { mockProviderToml, ruleModel, startMockModel } from './mock-responses.ts';

// 2026-11-06 真实规划核对：用户只在保存的要求里写了排除猎头，对话消息没有重复；计划的规范限制必须包含它，匿名雇主卡片才会被预筛。
test('保存要求中的猎头排除进入计划规范限制，匿名雇主卡片不打开详情', async () => {
  const message = '深圳后端2个，薪资不限，先存草稿';
  const plan = { city: '深圳', salaryMinK: null, criteria: '后端', sendNow: false, quote: message, excludedCompanies: [], degreeLimit: null, directions: [{ name: '后端', keywords: ['后端'], count: 2 }] };
  const mock = await startMockModel(ruleModel(plan, () => ({ decision: 'select', reason: '后端职责' })));
  const dir = tempDir('boss-requirement-exclusions-');
  fs.mkdirSync(path.join(dir, 'codex-home'));
  fs.writeFileSync(path.join(dir, 'codex-home', 'config.toml'), mockProviderToml(mock.baseUrl, 'gpt-mock'));
  const db = openState(path.join(dir, 'state.sqlite'));
  db.saveInputs({ greeting: '您好', requirements: '只找深圳。只在有明确证据时排除外包、猎头、中介：匿名雇主或页面明确标注。', resume: { text: '后端开发经验' } });
  db.close();
  const reads: string[] = [];
  const card = (jobId: string, patch: Partial<JobCard> = {}): JobCard => ({ jobId, title: '后端', company: `${jobId}科技`, salary: '20-30K', area: '深圳', snippet: '', url: `https://www.zhipin.com/job_detail/${jobId}.html`, degree: '本科', ...patch });
  const forbidden = async (): Promise<never> => { throw new Error('只找不投不能联系'); };
  const site: FakeSite = {
    open: async () => ({ page: 'ready', url: null }), status: async () => ({ page: 'ready', url: null }), close: async () => {},
    recommend: async () => [],
    search: async q => q.page === 1 ? [card('anon', { company: '某大型互联网公司', anonymous: true }), card('a'), card('b')] : [],
    jobDetail: async c => { reads.push(c.jobId); return `实际JD-${c.jobId}`; },
    openJob: forbidden, contact: forbidden, readChat: forbidden, sendGreeting: forbidden,
  };
  const server = await startServer({ readClock: instantReadClock, dataDir: dir, port: 0, site: countedSite(site) });
  try {
    await api(server.url, 'POST', '/api/chat', { message });
    await new Promise<AppState>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); server.app.off('changed', check); };
      const check = () => void server.app.getState().then(s => { if (!s.chat.pending && s.discovery.status === 'idle') { cleanup(); resolve(s); } }, e => { cleanup(); reject(e); });
      const timer = setTimeout(() => { cleanup(); reject(new Error('发现未结束')); }, 20_000);
      server.app.on('changed', check); check();
    });
    assert.deepEqual(reads, ['a', 'b']);
  } finally { await server.close(); mock.close(); }
});
