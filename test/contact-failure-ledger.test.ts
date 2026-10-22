import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openState } from '../src/state.ts';
import { draft } from './boss-fixture.ts';

test('普通失败不是未发生证明：保留inflight的unknown占位和额度', () => {
  const state = openState(':memory:');
  try {
    const batch = state.replaceBatch([draft()]);
    const target = batch.targets[0]!;
    state.setStep(target,'contact','inflight','点击前写入');
    state.setStep(target,'contact','failed','一般失败，未证明联系没有发生');
    assert.equal(state.isContacted(target.jobId),true);
    assert.equal(state.snapshot().contactedToday,1);
    assert.equal(state.snapshot().contactedCount,1);
  } finally {state.close();}
});

for (const previous of ['done','unknown'] as const) {
  test(`未发起联系的失败不清除同岗位既有${previous}账本`, () => {
    const state = openState(':memory:');
    try {
      const old = state.replaceBatch([draft()]);
      state.setStep(old.targets[0]!,'contact',previous,'既有联系证据');
      const current = state.replaceBatch([draft()]);
      state.setStep(current.targets[0]!,'contact','failed','打开岗位失败');
      assert.equal(state.isContacted(current.targets[0]!.jobId),true);
      assert.equal(state.snapshot().contactedToday,1);
      assert.equal(state.snapshot().contactedCount,1);
    } finally {state.close();}
  });
}
