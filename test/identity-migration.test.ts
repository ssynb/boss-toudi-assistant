import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openState } from '../src/state.ts';
import { tempDir } from './helpers.ts';

test('旧 recruiter_url 表原地迁移，不改变已联系身份、步骤和防重账本', () => {
  const file = path.join(tempDir('boss-identity-migration-'), 'state.sqlite');
  let state = openState(file);
  const batch = state.replaceBatch([{ jobId: 'A', company: '公司', title: '岗位', salary: '', url: 'https://www.zhipin.com/job_detail/A.html', reason: '', greeting: '你好' }]);
  const identity = { jobId: 'A', recruiterUrl: 'https://www.zhipin.com/boss_detail/hrA.html' };
  state.setStep(batch.targets[0]!, 'contact', 'done', '已联系', identity);
  const before = state.snapshot();
  state.close();
  const legacy = new DatabaseSync(file);
  legacy.exec('ALTER TABLE contact_identities DROP COLUMN kind; ALTER TABLE contact_identities RENAME COLUMN recruiter_value TO recruiter_url;');
  legacy.close();
  state = openState(file);
  assert.deepEqual(state.snapshot(), before);
  state.close();
});
