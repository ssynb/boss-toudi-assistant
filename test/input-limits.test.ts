import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server.ts';
import { INPUTS_MAX_BYTES, type AppState } from '../src/contracts.ts';
import { api, LOCAL, rawRequest, tempDir } from './helpers.ts';

test('10 MB 文件可统一保存，超过整个 JSON 上限时原输入不变', async () => {
  const server = await startServer({ dataDir: tempDir('boss-input-limit-'), port: 0 });
  try {
    const bytes = Buffer.alloc(10 * 1024 * 1024, 0x20);
    bytes.write('%PDF-1.7\n');
    const saved = await api<AppState>(server.url, 'PUT', '/api/inputs', {
      greeting: '您好，我有五年 React 经验', requirements: '北京前端，薪资不限',
      resume: { file: { fileName: 'resume.pdf', base64: bytes.toString('base64') }, text: '用于匹配的正文' },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.resume.file!.sizeBytes, bytes.length);
    const oversized = await rawRequest(server.url + '/api/inputs', { method: 'PUT', headers: { ...LOCAL, 'content-type': 'application/json' }, body: Buffer.alloc(INPUTS_MAX_BYTES + 1, 0x20) });
    assert.equal(oversized.status, 413);
    const after = (await api<AppState>(server.url, 'GET', '/api/state')).json;
    assert.equal(after.requirements, saved.json.requirements);
    assert.deepEqual(after.resume, saved.json.resume);
  } finally { await server.close(); }
});
