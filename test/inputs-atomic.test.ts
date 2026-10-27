import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openState } from '../src/state.ts';
import { startServer } from '../src/server.ts';
import { api, tempDir } from './helpers.ts';
import type { AppState, ApiError, SaveInputsRequest } from '../src/contracts.ts';

const inputs = (text: string): SaveInputsRequest => ({ greeting: '您好，我有五年 React 经验', requirements: text, resume: { file: { fileName: 'resume.txt', base64: Buffer.from(text).toString('base64') }, text: null } });
const draft = { jobId: 'a', company: '公司', title: '前端', salary: '', url: 'https://www.zhipin.com/job_detail/a.html', reason: '', greeting: '你好' };

for (const action of ['replace', 'delete'] as const) {
  test(`真实 SQLite 写入失败时回滚 ${action} 的文件字节、正文、要求和批准`, () => {
    const file = path.join(tempDir('boss-atomic-'), 'state.sqlite');
    let state = openState(file);
    state.saveInputs(inputs('旧资料'));
    const batch = state.replaceBatch([draft]);
    state.approve(batch.version);
    const before = state.snapshot();
    state.close();
    const db = new DatabaseSync(file);
    db.exec("CREATE TRIGGER reject_resume BEFORE INSERT ON kv WHEN NEW.key = 'resume' BEGIN SELECT RAISE(ABORT, 'storage failure'); END;");
    db.close();
    state = openState(file);
    const request = action === 'replace' ? inputs('新资料') : { greeting: '您好，我有五年 React 经验', requirements: '新要求', resume: { file: null, text: null } };
    assert.throws(() => state.saveInputs(request), /storage failure/);
    assert.deepEqual(state.snapshot(), before);
    state.close();
    const check = new DatabaseSync(file);
    assert.equal(Buffer.from(check.prepare('SELECT data FROM resume_file').get()!.data as Uint8Array).toString(), '旧资料');
    check.exec('DROP TRIGGER reject_resume');
    check.close();
    state = openState(file);
    state.saveInputs(request);
    assert.equal(state.snapshot().batch!.version, batch.version + 1);
    assert.equal(state.snapshot().batch!.status, 'draft');
    state.close();
    const saved = new DatabaseSync(file);
    const row = saved.prepare('SELECT data FROM resume_file').get();
    if (action === 'delete') assert.equal(row, undefined);
    else assert.equal(Buffer.from(row!.data as Uint8Array).toString(), '新资料');
    saved.close();
  });
}

test('旧磁盘简历真实读取失败时不删除原件；恢复文件后可迁移并重启读取', () => {
  const dir = tempDir('boss-migrate-');
  const file = path.join(dir, 'state.sqlite');
  openState(file).close();
  const bytes = Buffer.from('旧简历');
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const legacy = path.join(dir, 'resume', `${hash}.txt`);
  fs.mkdirSync(legacy, { recursive: true }); // 故障现场：该位置是目录，不是文件
  const db = new DatabaseSync(file);
  const resume = { file: { fileName: 'old.txt', extension: '.txt', sha256: hash, sizeBytes: bytes.length, uploadedAt: '2026-01-01' }, text: '旧简历', textSource: 'file', textConfirmed: true };
  db.prepare('INSERT OR REPLACE INTO kv VALUES (?, ?)').run('resume', JSON.stringify(resume));
  db.close();
  assert.throws(() => openState(file));
  assert.ok(fs.statSync(legacy).isDirectory());
  fs.rmdirSync(legacy);
  fs.writeFileSync(legacy, bytes);
  let state = openState(file);
  assert.equal(state.snapshot().resume.file!.sha256, hash);
  assert.equal(state.snapshot().resume.text, '旧简历');
  assert.ok(!('textConfirmed' in state.snapshot().resume));
  state.close();
  assert.ok(!fs.existsSync(legacy));
  state = openState(file);
  assert.equal(state.snapshot().resume.text, '旧简历');
  state.close();
  const check = new DatabaseSync(file);
  assert.deepEqual(Buffer.from(check.prepare('SELECT data FROM resume_file').get()!.data as Uint8Array), bytes);
  check.close();
});

test('严格 base64 解码及格式失败不改变任何已保存输入', () => {
  const state = openState(path.join(tempDir('boss-base64-'), 'state.sqlite'));
  state.saveInputs(inputs('已保存'));
  const before = state.snapshot();
  for (const base64 of ['!!!!', 'YQ', 'YQ==\n', 'data:text/plain;base64,YQ==', 'YR==']) {
    assert.throws(() => state.saveInputs({ ...inputs('新要求'), resume: { file: { fileName: 'resume.txt', base64 }, text: null } }), { code: 'bad_request' });
    assert.deepEqual(state.snapshot(), before);
  }
  state.close();
});

test('并发保存以完整提交互斥；旧分散接口全部不存在', async () => {
  const server = await startServer({ dataDir: tempDir('boss-input-http-'), port: 0 });
  try {
    const replies = await Promise.all(['甲资料', '乙资料'].map(text => api<AppState>(server.url, 'PUT', '/api/inputs', inputs(text))));
    for (const reply of replies) {
      assert.equal(reply.status, 200);
      assert.equal(reply.json.requirements, reply.json.resume.text);
    }
    for (const [method, url] of [['PUT','/api/requirements'], ['POST','/api/resume/file'], ['PUT','/api/resume/text'], ['DELETE','/api/resume']]) {
      const reply = await api<ApiError>(server.url, method!, url!, {});
      assert.equal(reply.status, 404);
    }
  } finally { await server.close(); }
});
