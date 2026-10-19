import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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

async function upload(name: string, bytes: Buffer) {
  const res = await fetch(`${server.url}/api/resume/file`, {
    method: 'POST',
    headers: { ...LOCAL, 'x-file-name': encodeURIComponent(name), 'content-type': 'application/octet-stream' },
    body: bytes,
  });
  return { status: res.status, json: (await res.json()) as AppState & ApiError };
}

function storedCopies(bytes: Buffer): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && fs.statSync(p).size === bytes.length && fs.readFileSync(p).equals(bytes)) found.push(p);
    }
  };
  walk(dataDir);
  return found;
}

test('上传 txt 简历：保存到本机数据目录并读出正文，等待用户确认', async () => {
  const bytes = Buffer.from('张三\n五年前端经验，熟悉 React 与 Node.js\n', 'utf8');
  const { status, json } = await upload('张三简历.txt', bytes);
  assert.equal(status, 200);
  assert.deepEqual(
    { ...json.resume.file, uploadedAt: undefined },
    { fileName: '张三简历.txt', extension: '.txt', sizeBytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), uploadedAt: undefined },
  );
  assert.equal(json.resume.text, bytes.toString('utf8'));
  assert.equal(json.resume.textSource, 'file');
  assert.equal(json.resume.textConfirmed, false);

  const copies = storedCopies(bytes);
  assert.equal(copies.length, 1);
  if (process.platform !== 'win32') assert.equal(fs.statSync(copies[0]!).mode & 0o077, 0, '仅本人可读');

  const confirmed = await api<AppState>(server.url, 'PUT', '/api/resume/text', { text: json.resume.text, confirmed: true });
  assert.equal(confirmed.json.resume.textConfirmed, true);
  assert.equal(confirmed.json.resume.textSource, 'file');
});

test('上传 pdf 简历只保存文件，正文需用户粘贴', async () => {
  const bytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), crypto.randomBytes(64)]);
  const { status, json } = await upload('resume.pdf', bytes);
  assert.equal(status, 200);
  assert.equal(json.resume.file?.extension, '.pdf');
  assert.equal(json.resume.text, '');
  assert.equal(json.resume.textConfirmed, false);

  const pasted = await api<AppState>(server.url, 'PUT', '/api/resume/text', { text: '粘贴的简历正文', confirmed: true });
  assert.equal(pasted.json.resume.textSource, 'pasted');
  assert.equal(pasted.json.resume.file?.extension, '.pdf');
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

test('简历正文未确认时不能开始发现', async () => {
  await api(server.url, 'DELETE', '/api/resume');
  const res = await api<ApiError>(server.url, 'POST', '/api/discovery/start');
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, 'resume_unconfirmed');
});
