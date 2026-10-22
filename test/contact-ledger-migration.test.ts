import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openState } from '../src/state.ts';
import { draft } from './boss-fixture.ts';
import { tempDir } from './helpers.ts';

test('旧联系账本无尝试归属时保留真实和未知记录，新尝试的未联系收尾只释放自身', () => {
  const file=path.join(tempDir('contact-ledger-migration-'),'state.sqlite');
  const legacy=new DatabaseSync(file);
  legacy.exec('CREATE TABLE contacts (job_id TEXT PRIMARY KEY, company TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, at TEXT NOT NULL)');
  for(const value of ['done','unknown'])legacy.prepare('INSERT INTO contacts VALUES (?, ?, ?, ?, ?)').run(value,'历史公司','岗位',value,new Date().toISOString());
  legacy.close();
  const state=openState(file);
  try {
    const baseline=state.snapshot();
    assert.equal(baseline.contactedToday,2);
    const batch=state.replaceBatch([draft()]);
    state.setStep(batch.targets[0]!,'contact','inflight','本次联系前');
    state.confirmNotContacted(batch.targets[0]!,'站点已核实未联系');
    assert.equal(state.isContacted(batch.targets[0]!.jobId),false);
    assert.equal(state.snapshot().contactedToday,baseline.contactedToday);
    assert.equal(state.snapshot().contactedCount,baseline.contactedCount);
  } finally {state.close();}
  const persisted=new DatabaseSync(file,{readOnly:true});
  try {assert.deepEqual(persisted.prepare('SELECT job_id, state FROM contacts ORDER BY job_id').all().map(r=>[r.job_id,r.state]),[['done','done'],['unknown','unknown']]);}
  finally {persisted.close();}
});
