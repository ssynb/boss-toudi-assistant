import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/server.ts';
import { cardPolicy } from '../src/search-plan.ts';
import type { JobCard, Site } from '../src/boss.ts';
import type { AppState } from '../src/contracts.ts';
import { countedSite, instantReadClock, tempDir, api , type FakeSite } from './helpers.ts';
import { mockProviderToml, startMockModel, type MockItem, type MockModel } from './mock-responses.ts';

test('常见公司屏蔽写法都形成名单；只找不投等不是名单', () => {
  for (const [text, companies] of [
    ['不要投软通动力公司', ['软通动力']],
    ['不投软通动力', ['软通动力']],
    ['公司黑名单：软通动力、外企德科', ['软通动力', '外企德科']],
    ['屏蔽软通动力、中软国际的岗位', ['软通动力', '中软国际']],
    ['只找不投，先存草稿', []],
    ['先存草稿不投递', []],
  ] as const) assert.deepEqual(cardPolicy([text]).companies, companies, text);
});

test('认得出是公司屏蔽指令却识别不出公司名时拒绝规划并要求澄清，不当作没有限制', () => {
  assert.throws(() => cardPolicy(['上述这类公司一律不投']), /无法识别/);
});

type Stage = { plan: object; corrected?: object };

/** 第一条消息只回复；之后按阶段提交计划，被拒绝时提交纠正版。判定全部入选。 */
async function scenario(requirementsLater: string, earlierMessage: string, stage: Stage, cards: JobCard[]) {
  let planned = 0;
  const script = (request: MockModel['requests'][number]): MockItem[] => {
    const last = request.input.at(-1) as { type?: string };
    const user = request.input.filter(item => (item as { role?: string }).role === 'user').at(-1) as { content: { text: string }[] } | undefined;
    const text = user?.content[0]?.text ?? '';
    const judging = text.includes('"jobs"');
    if (last?.type === 'function_call_output') {
      if (!judging && planned === 1 && stage.corrected && JSON.stringify(last).includes('工具出错')) { planned++; return [{ type: 'function_call', name: 'start_delivery', args: stage.corrected }]; }
      return [{ type: 'message', text: '完成' }];
    }
    if (judging) {
      const jobs = JSON.parse(text).jobs as { card: { jobId: string } }[];
      return [{ type: 'function_call', name: 'submit_decisions', args: { decisions: jobs.map(({ card }) => ({ jobId: card.jobId, decision: 'select', reason: '后端职责' })) } }];
    }
    if (!text.includes('先存草稿')) return [{ type: 'function_call', name: 'reply', args: { text: '好的' } }];
    planned++;
    return [{ type: 'function_call', name: 'start_delivery', args: stage.plan }];
  };
  const mock = await startMockModel(script);
  const dir = tempDir('boss-policy-order-');
  fs.mkdirSync(path.join(dir, 'codex-home'));
  fs.writeFileSync(path.join(dir, 'codex-home', 'config.toml'), mockProviderToml(mock.baseUrl, 'gpt-mock'));
  const reads: string[] = [];
  const forbidden = async (): Promise<never> => { throw new Error('只找不投不能联系'); };
  const site: FakeSite = {
    open: async () => ({ page: 'ready', url: null }), status: async () => ({ page: 'ready', url: null }), close: async () => {},
    recommend: async () => [], search: async q => q.page === 1 ? cards : [],
    jobDetail: async c => { reads.push(c.jobId); return `实际JD-${c.jobId}`; },
    openJob: forbidden, contact: forbidden, readChat: forbidden, sendGreeting: forbidden,
  };
  const server = await startServer({ readClock: instantReadClock, dataDir: dir, port: 0, site: countedSite(site) });
  const idle = () => new Promise<AppState>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); server.app.off('changed', check); };
    const check = () => void server.app.getState().then(s => { if (!s.chat.pending && s.discovery.status === 'idle') { cleanup(); resolve(s); } }, e => { cleanup(); reject(e); });
    const timer = setTimeout(() => { cleanup(); reject(new Error('未结束')); }, 20_000);
    server.app.on('changed', check); check();
  });
  try {
    await api(server.url, 'PUT', '/api/inputs', { greeting: '您好', requirements: '深圳后端', resume: { text: '后端开发经验' } });
    await api(server.url, 'POST', '/api/chat', { message: earlierMessage });
    await idle();
    assert.equal((await api(server.url, 'PUT', '/api/inputs', { greeting: '您好', requirements: requirementsLater, resume: { text: null } })).status, 200);
    await api(server.url, 'POST', '/api/chat', { message: '深圳后端2个，薪资不限，先存草稿' });
    await idle();
    return { reads, planned };
  } finally { await server.close(); mock.close(); }
}

const quote = '深圳后端2个，薪资不限，先存草稿';
const base = { city: '深圳', salaryMinK: null, criteria: '后端', sendNow: false, quote, directions: [{ name: '后端', keywords: ['后端'], count: 2 }] };
const card = (jobId: string, patch: Partial<JobCard> = {}): JobCard => ({ jobId, title: '后端', company: `${jobId}科技`, salary: '20-30K', area: '深圳', snippet: '', url: `https://www.zhipin.com/job_detail/${jobId}.html`, degree: '本科', ...patch });

test('之后重新保存的要求优先于更早的允许消息：旧消息不能解除当前黑名单与学历门槛', async () => {
  const degreeLimit = { from: '硕士', quote: '岗位卡片明确要求硕士及以上的不要投' };
  const { reads, planned } = await scenario('软通动力一律不投。岗位卡片明确要求硕士及以上的不要投。', '这次允许投软通动力，硕士要求的岗位也可以投', {
    plan: { ...base, excludedCompanies: [], degreeLimit: null },
    corrected: { ...base, excludedCompanies: ['软通动力'], degreeLimit },
  }, [card('brand', { company: '软通动力信息' }), card('master', { degree: '硕士' }), card('a'), card('b')]);
  assert.equal(planned, 2, '沿用旧允许的计划必须被拒绝');
  assert.deepEqual(reads, ['a', 'b']);
});

test('之后保存的「不排除猎头」优先于更早消息里的排除，匿名雇主卡片照常读取', async () => {
  const { reads } = await scenario('深圳后端，不排除猎头。', '不要猎头', { plan: { ...base, excludedCompanies: [], degreeLimit: null } },
    [card('anon', { company: '某大型互联网公司', anonymous: true }), card('a')]);
  assert.deepEqual(reads, ['anon', 'a']);
});
