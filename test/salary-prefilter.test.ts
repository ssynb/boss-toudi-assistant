import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/server.ts';
import type { Site } from '../src/boss.ts';
import type { AppState } from '../src/contracts.ts';
import { api, tempDir } from './helpers.ts';
import { startMockModel, mockProviderToml, type MockItem } from './mock-responses.ts';

async function discover(salaries: [string, string][], selected: string[], salaryMinK: number | null, initiallyNull = false) {
  const message = salaryMinK === null ? '深圳Python，薪资不限，先找岗位存草稿' : '深圳Python，月薪上限到20K就行，先找岗位存草稿';
  const plan = { city: '深圳', salaryMinK, criteria: salaryMinK === null ? 'Python，薪资不限' : 'Python，月薪区间上限到20K即可', sendNow: false, quote: message, directions: [{ name: 'Python', keywords: ['Python'], count: selected.length }] };
  const action = (value: typeof plan): MockItem[] => [{ type: 'function_call', name: 'start_delivery', args: value }];
  const mock = await startMockModel([
    ...(initiallyNull ? [action({ ...plan, salaryMinK: null })] : []), action(plan), [{ type: 'message', text: '计划完成' }],
    [{ type: 'function_call', name: 'submit_decisions', args: { decisions: selected.map(jobId => ({ jobId, decision: 'select', reason: 'Python主要职责匹配，月薪口径符合要求', greeting: '您好，我有Python经验' })) } }],
    [{ type: 'message', text: '完成' }],
  ]);
  const dir = tempDir('boss-salary-prefilter-');
  fs.mkdirSync(path.join(dir, 'codex-home'));
  fs.writeFileSync(path.join(dir, 'codex-home', 'config.toml'), mockProviderToml(mock.baseUrl, 'gpt-mock'));
  const reads: string[] = [];
  const forbidden = async (): Promise<never> => { throw new Error('只找不投不能联系'); };
  const site: Site = {
    open: async () => ({ page: 'ready', url: null }), close: async () => {}, status: async () => ({ page: 'ready', url: null }),
    search: async q => q.page === 1 ? salaries.map(([jobId, salary]) => ({ jobId, salary, title: 'Python开发', company: '测试公司', area: '深圳', snippet: '', url: `https://www.zhipin.com/job_detail/${jobId}.html` })) : [],
    jobDetail: async card => { reads.push(card.jobId); return `实际JD-${card.jobId}：Python开发，明确月薪区间20-25K`; },
    openJob: forbidden, contact: forbidden, readChat: forbidden, sendGreeting: forbidden,
  };
  const server = await startServer({ dataDir: dir, port: 0, site });
  try {
    await api(server.url, 'PUT', '/api/inputs', { requirements: '', resume: { text: 'Python开发经验' } });
    await api(server.url, 'POST', '/api/chat', { message });
    const state = await new Promise<AppState>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); server.app.off('changed', check); };
      const check = () => void server.app.getState().then(s => { if (!s.chat.pending && s.discovery.status === 'idle') { cleanup(); resolve(s); } }, e => { cleanup(); reject(e); });
      const timer = setTimeout(() => { cleanup(); reject(new Error('发现未结束')); }, 10_000);
      server.app.on('changed', check); check();
    });
    return { state, reads, requests: mock.requests };
  } finally { await server.close(); mock.close(); }
}

test('薪资卡片预筛按月薪上限，不读低薪/日薪/时薪JD、不消耗详情预算，面议照常读', async () => {
  const low: [string, string][] = [
    ...Array.from({ length: 50 }, (_, i): [string, string] => [`low${i}`, '10-18K']),
    ['bonus', '10-18K·16薪'], ['decimal-low', '19.99K'], ['k-month', '5k-10k/月'],
    ['daily', '200-500元/天'], ['hourly', '50-100元/小时'], ['yuan-low', '8000-15000元/月'],
    ['per-day', '200-500元/日'], ['per-hour', '30-50元/时'],
  ];
  const allowed: [string, string][] = [
    ['range', '15-25K'], ['edge-bonus', '15-20K·13薪'], ['decimal', '19.5-20.0K/月'],
    ['yuan-high', '15000-20000元/月'], ['negotiable', '面议'], ['unknown', '薪资待定'],
  ];
  const { state, reads } = await discover([...low, low[0]!, ...allowed], allowed.map(([id]) => id), 20);
  assert.deepEqual(reads, ['range', 'edge-bonus', 'decimal', 'yuan-high', 'negotiable', 'unknown']);
  assert.deepEqual(state.batch!.targets.map(t => t.jobId), reads);
  assert.match(state.discovery.message!, /尝试读取 6\/36/);
  assert.match(state.discovery.message!, /卡片预筛排除 58 个/);
  assert.match(state.discovery.message!, /薪资不足 58/);
  assert.ok(state.chat.messages.some(m => /Python.*卡片预筛排除 58 个/.test(m.text)), '每方向结果写回对话');
});

test('薪资明确不限时不按工资格式或金额预筛', async () => {
  const { state, reads } = await discover([['daily', '200元/天'], ['low', '5-10K'], ['unknown', '面议']], ['daily', 'low', 'unknown'], null);
  assert.deepEqual(reads, ['daily', 'low', 'unknown']);
  assert.equal(state.batch!.targets.length, 3);
  assert.match(state.discovery.message!, /卡片预筛排除 0 个/);
});

test('顾问不能把“月薪上限到20K就行”仅写criteria并用null绕过薪资阈值', async () => {
  const { state, reads, requests } = await discover([['low', '10-18K'], ['match', '15-25K']], ['match'], 20, true);
  assert.match(JSON.stringify(requests[1]?.input.at(-1)), /salaryMinK|阈值/);
  assert.deepEqual(reads, ['match']);
  assert.equal(state.batch!.targets[0]!.jobId, 'match');
  const user = requests[3]!.input.filter(item => (item as { role?: string }).role === 'user').at(-1) as { content: { text: string }[] };
  assert.equal(JSON.parse(user.content[0]!.text).salaryMinK, 20);
});
