import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { openState } from '../src/state.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import type { Site } from '../src/boss.ts';
import type { AppState, ApiError } from '../src/contracts.ts';
import { api, tempDir } from './helpers.ts';
import { mockProviderToml, startMockModel } from './mock-responses.ts';

const inputs = { requirements: '北京前端，薪资不限', resume: { text: '前端简历' } };

for (const ending of ['完成', '已停止', '发现失败：连接中断']) {
  test(`发现${ending}时固定结束时间，刷新/保存/重启不重置`, () => {
    const file = path.join(tempDir('boss-time-'), 'state.sqlite');
    let state = openState(file);
    state.saveInputs(inputs);
    const lower = Date.now();
    state.beginDiscovery();
    const running = state.snapshot().discovery;
    assert.equal(running.status, 'running');
    assert.ok(Date.parse(running.startedAt!) >= lower);
    assert.equal(running.finishedAt, null);
    assert.throws(() => state.saveInputs(inputs), { code: 'busy' });
    assert.throws(() => state.beginDiscovery(), { code: 'busy' });
    assert.equal(state.snapshot().discovery.startedAt, running.startedAt);
    if (ending === '已停止') {
      state.requestDiscoveryStop();
      assert.equal(state.snapshot().discovery.status, 'stopping');
      assert.equal(state.snapshot().discovery.finishedAt, null);
    }
    state.finishDiscovery(ending);
    const finished = state.snapshot().discovery;
    assert.equal(finished.status, 'idle');
    assert.equal(finished.message, ending);
    assert.equal(finished.startedAt, running.startedAt);
    assert.ok(Date.parse(finished.finishedAt!) >= Date.parse(finished.startedAt!));
    assert.ok(Date.parse(finished.finishedAt!) <= Date.now());
    state.finishDiscovery('不应该覆盖');
    assert.deepEqual(state.snapshot().discovery, finished);
    state.saveInputs(inputs);
    assert.equal(state.snapshot().discovery.finishedAt, finished.finishedAt);
    state.close();
    state = openState(file);
    assert.equal(state.snapshot().discovery.startedAt, running.startedAt);
    assert.equal(state.snapshot().discovery.finishedAt, finished.finishedAt);
    state.close();
  });
}

for (const stopping of [false, true]) {
  test(`重启恢复${stopping ? 'stopping' : 'running'}发现：记录检测中断时间而非重新开始`, () => {
    const file = path.join(tempDir('boss-time-recover-'), 'state.sqlite');
    let state = openState(file);
    state.saveInputs(inputs);
    state.beginDiscovery();
    const started = state.snapshot().discovery.startedAt;
    if (stopping) state.requestDiscoveryStop();
    state.close();
    const before = Date.now();
    state = openState(file);
    const recovered = state.snapshot().discovery;
    assert.equal(recovered.status, 'idle');
    assert.equal(recovered.startedAt, started);
    assert.ok(Date.parse(recovered.finishedAt!) >= before);
    assert.match(recovered.message!, /中断/);
    state.close();
    state = openState(file);
    assert.deepEqual(state.snapshot().discovery, recovered);
    state.close();
  });
}

function waitIdle(server: RunningServer): Promise<AppState> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('发现未结束')); }, 10_000);
    const check = () => void server.app.getState().then(s => {
      if (s.discovery.status === 'idle') { cleanup(); resolve(s); }
    }, reject);
    const cleanup = () => { clearTimeout(timer); server.app.off('changed', check); };
    server.app.on('changed', check);
    check();
  });
}

test('真实 Codex 工具在途时停止：先 stopping、禁保存，工具结束后才固定 finishedAt', async () => {
  const mock = await startMockModel([
    [{ type: 'function_call', name: 'set_search_plan', args: { keywords: ['前端'], city: '北京', salaryMinK: null, maxTargets: 10, excludeCompanies: [], quotes: { direction: '前端', city: '北京', salary: '薪资不限' } } }],
    [{ type: 'message', text: '计划完成' }],
  ]);
  const dir = tempDir('boss-time-rpc-');
  fs.mkdirSync(path.join(dir, 'codex-home'));
  fs.writeFileSync(path.join(dir, 'codex-home', 'config.toml'), mockProviderToml(mock.baseUrl, 'gpt-mock'));
  let entered!: () => void;
  const searching = new Promise<void>(r => { entered = r; });
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const forbidden = async (): Promise<never> => { throw new Error('不能联系'); };
  const site: Site = {
    open: async () => ({ page: 'ready', url: null }), status: async () => ({ page: 'ready', url: null }), close: async () => {},
    search: async () => { entered(); await gate; return []; }, jobDetail: async () => '',
    openJob: forbidden, contact: forbidden, readChat: forbidden, sendGreeting: forbidden,
  };
  const server = await startServer({ dataDir: dir, port: 0, site });
  try {
    await api(server.url, 'PUT', '/api/inputs', inputs);
    const start = await api<AppState>(server.url, 'POST', '/api/discovery/start');
    assert.equal(start.status, 200);
    await searching;
    const stop = await api<AppState>(server.url, 'POST', '/api/discovery/stop');
    assert.equal(stop.json.discovery.status, 'stopping');
    assert.equal(stop.json.discovery.startedAt, start.json.discovery.startedAt);
    assert.equal(stop.json.discovery.finishedAt, null);
    const denied = await api<ApiError>(server.url, 'PUT', '/api/inputs', inputs);
    assert.equal(denied.status, 409);
    assert.equal(denied.json.error.code, 'busy');
    const idle = waitIdle(server);
    release();
    const finished = (await idle).discovery;
    assert.ok(finished.finishedAt);
    assert.equal(finished.startedAt, start.json.discovery.startedAt);
    assert.equal((await api<AppState>(server.url, 'GET', '/api/state')).json.discovery.finishedAt, finished.finishedAt);
  } finally { release(); await server.close(); mock.close(); }
});

test('未登录的开始请求被拒绝，不创建发现计时', async () => {
  const server = await startServer({ dataDir: tempDir('boss-time-auth-'), port: 0 });
  try {
    await api(server.url, 'PUT', '/api/inputs', inputs);
    const denied = await api<ApiError>(server.url, 'POST', '/api/discovery/start');
    assert.equal(denied.status, 409);
    const state = (await api<AppState>(server.url, 'GET', '/api/state')).json;
    assert.equal(state.discovery.startedAt, null);
    assert.equal(state.discovery.finishedAt, null);
  } finally { await server.close(); }
});
