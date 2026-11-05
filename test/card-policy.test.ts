import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/server.ts';
import { openState } from '../src/state.ts';
import { readSearchPlan } from '../src/search-plan.ts';
import type { JobCard, Site } from '../src/boss.ts';
import type { AppState } from '../src/contracts.ts';
import { countedSite, instantReadClock, tempDir, api } from './helpers.ts';
import { mockProviderToml, startMockModel, type MockItem, type MockModel } from './mock-responses.ts';

// 与用户当前保存要求同一写法：品牌后括号列出别名，学历门槛与「硕士优先不排除」并存。
const REQUIREMENTS = '只找深圳，不要猎头。学历硬条件：岗位卡片明确要求硕士及以上或博士的不要投，不打开详情；本科、大专、学历不限和学历未知不据此排除，硕士优先等非硬要求不据此排除。\n用户明确公司屏蔽：软通动力（含isoftstone及带软通动力名称的招聘主体）、外企德科（含外企德科数字、FESCO Adecco及带外企德科名称的招聘主体）一律不投，即使JD没有写外包也排除。这是具体公司黑名单，优先于一般规则。';
const ALL_BRANDS = ['软通动力', 'isoftstone', '外企德科', '外企德科数字', 'FESCO Adecco'];
const DEGREE = { from: '硕士', quote: '岗位卡片明确要求硕士及以上或博士的不要投' };
const latest = '深圳后端10个，薪资不限，开始';
const base = { city: '深圳', salaryMinK: null, criteria: '后端', sendNow: false, quote: '开始', directions: [{ name: '后端', keywords: ['后端'], count: 10 }] };
const read = (patch: object, sources = [REQUIREMENTS], message = latest) => readSearchPlan({ ...base, ...patch }, message, 0, ['薪资不限'], sources);

test('计划的卡片策略必须与当前要求推导的完整策略一致：缺漏、只填部分别名或多填都在接收时拒绝', () => {
  const ok = read({ excludedCompanies: ALL_BRANDS.map(name => name.toUpperCase()), degreeLimit: DEGREE });
  assert.equal(ok.excludedCompanies!.length, ALL_BRANDS.length);
  for (const patch of [
    {}, { degreeLimit: DEGREE }, { excludedCompanies: ALL_BRANDS },
    { excludedCompanies: ['软通', '外企德科'], degreeLimit: DEGREE },
    { excludedCompanies: ALL_BRANDS.filter(name => name !== 'FESCO Adecco'), degreeLimit: DEGREE },
    { excludedCompanies: [...ALL_BRANDS, '招聘主体'], degreeLimit: DEGREE },
    { excludedCompanies: ALL_BRANDS, degreeLimit: { from: '博士', quote: DEGREE.quote } },
  ]) assert.throws(() => read(patch), /excludedCompanies|degreeLimit/, JSON.stringify(patch));
});

test('提到公司或学历但不是排除指令时不得形成卡片策略', () => {
  const sources = ['我曾在软通动力工作三年，硕士在读也没关系'];
  assert.doesNotThrow(() => read({ excludedCompanies: [], degreeLimit: null }, sources));
  assert.throws(() => read({ excludedCompanies: ['软通动力'], degreeLimit: null }, sources), /excludedCompanies/);
});

test('最新用户消息解除排除优先于旧要求', () => {
  const sources = [REQUIREMENTS, '这次允许投外企德科', '硕士要求的岗位也可以投'];
  const rest = ['软通动力', 'isoftstone'];
  assert.doesNotThrow(() => read({ excludedCompanies: rest, degreeLimit: null }, sources));
  assert.throws(() => read({ excludedCompanies: ALL_BRANDS, degreeLimit: null }, sources), /excludedCompanies/);
  assert.throws(() => read({ excludedCompanies: rest, degreeLimit: DEGREE }, sources), /degreeLimit/);
});

test('规划工具在接收边界拒绝漏填卡片策略，模型按提示纠正后才开始且不打开被策略排除的JD', async () => {
  const message = '深圳后端2个，薪资不限，先存草稿';
  const plan = { ...base, quote: message, directions: [{ name: '后端', keywords: ['后端'], count: 2 }] };
  const corrected = { ...plan, excludedCompanies: ALL_BRANDS, degreeLimit: DEGREE };
  let planned = 0;
  const script = (request: MockModel['requests'][number]): MockItem[] => {
    const last = request.input.at(-1) as { type?: string; output?: unknown };
    const user = request.input.filter(item => (item as { role?: string }).role === 'user').at(-1) as { content: { text: string }[] } | undefined;
    const judging = (user?.content[0]?.text ?? '').includes('"jobs"');
    if (last?.type === 'function_call_output') {
      if (!judging && planned === 1) { planned++; return [{ type: 'function_call', name: 'start_delivery', args: corrected }]; }
      return [{ type: 'message', text: '完成' }];
    }
    if (!judging) { planned++; return [{ type: 'function_call', name: 'start_delivery', args: plan }]; }
    const jobs = JSON.parse(user!.content[0]!.text).jobs as { card: { jobId: string } }[];
    return [{ type: 'function_call', name: 'submit_decisions', args: { decisions: jobs.map(({ card }) => ({ jobId: card.jobId, decision: 'select', reason: '后端职责' })) } }];
  };
  const mock = await startMockModel(script);
  const dir = tempDir('boss-card-policy-');
  fs.mkdirSync(path.join(dir, 'codex-home'));
  fs.writeFileSync(path.join(dir, 'codex-home', 'config.toml'), mockProviderToml(mock.baseUrl, 'gpt-mock'));
  const db = openState(path.join(dir, 'state.sqlite'));
  db.saveInputs({ greeting: '您好', requirements: REQUIREMENTS, resume: { text: '后端开发经验' } });
  db.close();
  const reads: string[] = [];
  const card = (jobId: string, patch: Partial<JobCard> = {}): JobCard => ({ jobId, title: '后端', company: `${jobId}科技`, salary: '20-30K', area: '深圳', snippet: '', url: `https://www.zhipin.com/job_detail/${jobId}.html`, degree: '本科', ...patch });
  const forbidden = async (): Promise<never> => { throw new Error('只找不投不能联系'); };
  const site: Site = {
    open: async () => ({ page: 'ready', url: null }), status: async () => ({ page: 'ready', url: null }), close: async () => {},
    recommend: async () => [],
    search: async q => q.page === 1 ? [card('fesco', { company: 'FESCO Adecco深圳' }), card('master', { degree: '硕士' }), card('near', { company: '软通智慧' }), card('ok')] : [],
    jobDetail: async c => { reads.push(c.jobId); return `实际JD-${c.jobId}`; },
    openJob: forbidden, contact: forbidden, readChat: forbidden, sendGreeting: forbidden,
  };
  const server = await startServer({ readClock: instantReadClock, dataDir: dir, port: 0, site: countedSite(site) });
  try {
    await api(server.url, 'POST', '/api/chat', { message });
    const state = await new Promise<AppState>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); server.app.off('changed', check); };
      const check = () => void server.app.getState().then(s => { if (!s.chat.pending && s.discovery.status === 'idle') { cleanup(); resolve(s); } }, e => { cleanup(); reject(e); });
      const timer = setTimeout(() => { cleanup(); reject(new Error('发现未结束')); }, 20_000);
      server.app.on('changed', check); check();
    });
    assert.equal(planned, 2, '漏填计划须被拒绝并由模型重新提交');
    assert.match(JSON.stringify(mock.requests[1]!.input.at(-1)), /excludedCompanies/);
    assert.deepEqual(reads, ['near', 'ok']);
    assert.deepEqual(state.batch!.targets.map(t => t.jobId), ['near', 'ok']);
  } finally { await server.close(); mock.close(); }
});
