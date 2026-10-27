import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openState } from '../src/state.ts';
import { tempDir } from './helpers.ts';

test('迁移已提交但旧文件清理失败时，保留数据库字节和恢复标记，下次启动继续清理', () => {
  const dir = tempDir('boss-cleanup-');
  const file = path.join(dir, 'state.sqlite');
  const bytes = Buffer.from('迁移后的简历');
  const state = openState(file);
  state.saveInputs({ greeting: '您好，我有五年 React 经验', requirements: '旧要求', resume: { file: { fileName: 'resume.txt', base64: bytes.toString('base64') }, text: null } });
  const original = state.snapshot().resume;
  state.close();
  const meta = original.file!;
  const legacy = path.join(dir, 'resume', meta.sha256 + meta.extension);
  fs.mkdirSync(legacy, { recursive: true });
  const db = new DatabaseSync(file);
  db.prepare('INSERT INTO kv VALUES (?, ?)').run('legacy_resume_cleanup', JSON.stringify(meta));
  db.close();
  assert.throws(() => openState(file), /directory|EISDIR/i);
  const retained = new DatabaseSync(file);
  assert.deepEqual(Buffer.from(retained.prepare('SELECT data FROM resume_file').get()!.data as Uint8Array), bytes);
  assert.ok(retained.prepare("SELECT value FROM kv WHERE key = 'legacy_resume_cleanup'").get());
  retained.close();
  fs.rmdirSync(legacy);
  fs.writeFileSync(legacy, bytes);
  const recovered = openState(file);
  assert.deepEqual(recovered.snapshot().resume, original);
  assert.equal(recovered.snapshot().requirements, '旧要求');
  recovered.close();
  assert.ok(!fs.existsSync(legacy));
  const checked = new DatabaseSync(file);
  assert.equal(checked.prepare("SELECT value FROM kv WHERE key = 'legacy_resume_cleanup'").get(), undefined);
  checked.close();
});

test('含已移除附件字段的旧库仍能读取原批次并生成新批次', () => {
  const file = path.join(tempDir('boss-old-columns-'), 'state.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE batch (id TEXT PRIMARY KEY, version INTEGER NOT NULL, status TEXT NOT NULL, approved_version INTEGER,
    resume_delivery TEXT NOT NULL, stop_reason TEXT, created_at TEXT NOT NULL);
  CREATE TABLE targets (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, ord INTEGER NOT NULL, job_id TEXT NOT NULL,
    company TEXT NOT NULL, title TEXT NOT NULL, salary TEXT NOT NULL, url TEXT NOT NULL, reason TEXT NOT NULL, greeting TEXT NOT NULL,
    removed INTEGER NOT NULL, contact TEXT NOT NULL, greeting_state TEXT NOT NULL, resume TEXT NOT NULL, evidence TEXT NOT NULL, updated_at TEXT NOT NULL);
  INSERT INTO batch VALUES ('b', 3, 'paused', NULL, '{"enabled":false}', NULL, '2026-01-01');
  INSERT INTO targets VALUES ('t', 'b', 0, 'old', '公司', '岗位', '', 'https://www.zhipin.com/job_detail/old.html', '', '你好', 0, 'done', 'done', 'skipped', '', '2026-01-01');`);
  db.close();
  const state = openState(file);
  assert.deepEqual(state.snapshot().batch!.targets[0]!.steps, { contact: 'done', greeting: 'done' });
  const next = state.replaceBatch([{ jobId: 'new', company: '公司', title: '岗位', salary: '', url: 'https://www.zhipin.com/job_detail/new.html', reason: '', greeting: '你好' }]);
  assert.equal(next.version, 4);
  state.close();
});
