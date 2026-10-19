import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer, type RunningServer } from '../src/server.ts';
import type { AppState, ApiError } from '../src/contracts.ts';
import { api, LOCAL, rawRequest, tempDir } from './helpers.ts';

let server: RunningServer;
let dataDir: string;

before(async () => {
  dataDir = tempDir('boss-server-');
  server = await startServer({ dataDir, port: 0 });
});
after(() => server.close());

const host = () => `127.0.0.1:${server.port}`;

test('只接受本机同源请求，拒绝缺头、DNS 重绑定与跨站来源', async () => {
  const url = `${server.url}/api/state`;
  const rejected: Array<[string, Record<string, string>]> = [
    ['缺少 X-Boss-Local', { host: host() }],
    ['DNS 重绑定的 Host', { ...LOCAL, host: `evil.example:${server.port}` }],
    ['端口不符的 Host', { ...LOCAL, host: '127.0.0.1:1' }],
    ['跨站 Origin', { ...LOCAL, host: host(), origin: 'http://evil.example' }],
    ['跨站 fetch 元数据', { ...LOCAL, host: host(), 'sec-fetch-site': 'cross-site' }],
  ];
  for (const [name, headers] of rejected) {
    const res = await rawRequest(url, { headers });
    assert.equal(res.status, 403, name);
    assert.equal(res.headers['access-control-allow-origin'], undefined, name);
    assert.equal((JSON.parse(res.body) as ApiError).error.code, 'forbidden', name);
  }

  const preflight = await rawRequest(url, {
    method: 'OPTIONS',
    headers: { host: host(), origin: 'http://evil.example', 'access-control-request-headers': 'x-boss-local' },
  });
  assert.equal(preflight.status, 403);
  assert.equal(preflight.headers['access-control-allow-origin'], undefined);

  const events = await rawRequest(`${server.url}/api/events`, { headers: { host: host() } });
  assert.equal(events.status, 403);

  const ok = await rawRequest(url, { headers: { ...LOCAL, host: host(), origin: `http://${host()}` } });
  assert.equal(ok.status, 200);
  const state = JSON.parse(ok.body) as AppState;
  assert.equal(state.batch, null);
  assert.equal(state.resume.file, null);
});

test('静态页面同样拒绝 DNS 重绑定的 Host', async () => {
  const res = await rawRequest(`${server.url}/`, { headers: { host: `evil.example:${server.port}` } });
  assert.equal(res.status, 403);
});

async function upload(name: string, bytes: Buffer, text: string | null = null) {
  return api<AppState & ApiError>(server.url, 'PUT', '/api/inputs', {
    requirements: '北京前端，薪资不限', resume: { file: { fileName: name, base64: bytes.toString('base64') }, text },
  });
}

test('统一保存 txt 简历自动提取正文，不再需要确认勾选', async () => {
  const bytes = Buffer.from('张三\n五年前端经验，熟悉 React 与 Node.js\n', 'utf8');
  const { status, json } = await upload('张三简历.txt', bytes);
  assert.equal(status, 200);
  assert.deepEqual(
    { ...json.resume.file, uploadedAt: undefined },
    { fileName: '张三简历.txt', extension: '.txt', sizeBytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), uploadedAt: undefined },
  );
  assert.equal(json.resume.text, bytes.toString('utf8'));
  assert.equal(json.resume.textSource, 'file');
  assert.ok(!('textConfirmed' in json.resume));
});

test('不能解析的 pdf 必须在同一次保存提供正文，不发生部分上传', async () => {
  const before = (await api<AppState>(server.url, 'GET', '/api/state')).json;
  const bytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), crypto.randomBytes(64)]);
  const missing = await upload('resume.pdf', bytes);
  assert.equal(missing.status, 409);
  assert.equal(missing.json.error.code, 'inputs_incomplete');
  const unchanged = (await api<AppState>(server.url, 'GET', '/api/state')).json;
  assert.deepEqual(unchanged.resume, before.resume);
  assert.equal(unchanged.requirements, before.requirements);
  const saved = await upload('resume.pdf', bytes, '粘贴的简历正文');
  assert.equal(saved.status, 200);
  assert.equal(saved.json.resume.text, '粘贴的简历正文');
  assert.equal(saved.json.resume.textSource, 'pasted');
  assert.equal(saved.json.resume.file?.extension, '.pdf');
});

test('拒绝不支持或与扩展名不符的简历文件', async () => {
  const cases: Array<[string, Buffer, string]> = [
    ['run.exe', Buffer.from('MZ....'), 'unsupported_file'],
    ['fake.pdf', Buffer.from('not a pdf'), 'unsupported_file'],
    ['fake.docx', Buffer.from('not a zip'), 'unsupported_file'],
    ['binary.txt', Buffer.from([0xff, 0xfe, 0x00, 0xd8]), 'unsupported_file'],
  ];
  for (const [name, bytes, code] of cases) {
    const { status, json } = await upload(name, bytes);
    assert.equal(status, 400, name);
    assert.equal(json.error.code, code, name);
  }
});

test('简历超过大小上限被拒绝', async () => {
  const { status, json } = await upload('big.txt', Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));
  assert.equal(status, 413);
  assert.equal(json.error.code, 'file_too_large');
});

test('没有已保存的有效正文时不能开始发现', async () => {
  await api(server.url, 'PUT', '/api/inputs', { requirements: '', resume: { file: null, text: null } });
  const res = await api<ApiError>(server.url, 'POST', '/api/discovery/start');
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, 'inputs_incomplete');
});
