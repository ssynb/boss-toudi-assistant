import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createBossSite } from '../src/boss.ts';
import { Executor } from '../src/executor.ts';
import { openState } from '../src/state.ts';
import { tempDir } from './helpers.ts';
import { bossBrowser, draft, localBrowser, startBoss } from './boss-fixture.ts';

test('额度提示关闭后核实未联系：真实站点链路落账failed，重启恢复不再次点击', async () => {
  const f = await startBoss({quotaNotice:'not-contacted'});
  const browser = localBrowser('quota-ledger');
  const site = createBossSite(bossBrowser(browser,f));
  const file = path.join(tempDir('quota-ledger-'),'state.sqlite');
  let state = openState(file);
  try {
    const historical = state.replaceBatch(['old-done','old-unknown'].map(jobId => ({...draft(),jobId,url:`https://www.zhipin.com/job_detail/${jobId}.html`})));
    state.setStep(historical.targets[0]!, 'contact', 'done', '此前真实联系');
    state.setStep(historical.targets[1]!, 'contact', 'unknown', '此前结果不明');
    const before = state.snapshot();
    const batch = state.replaceBatch([draft()]);
    state.approve(batch.version);
    await new Executor(state,site).start();
    const paused = state.snapshot().batch!;
    assert.equal(paused.status,'paused');
    assert.deepEqual(paused.targets[0]!.steps,{contact:'failed',greeting:'skipped'});
    assert.match(paused.stopReason!,/联系未发生/);
    assert.match(paused.stopReason!,/120/);
    assert.match(paused.stopReason!,/30/);
    assert.deepEqual([f.contacts,f.quotaDismissals,f.sends],[1,1,[]]);
    assert.equal(state.isContacted(batch.targets[0]!.jobId), false, '本次未联系不应残留unknown占位');
    assert.equal(state.snapshot().contactedToday, before.contactedToday, '额度应恢复到本次尝试前');
    assert.equal(state.snapshot().contactedCount, before.contactedCount);
    state.close();
    state = openState(file);
    assert.deepEqual(state.snapshot().batch!.targets[0]!.steps,{contact:'failed',greeting:'skipped'});
    assert.equal(state.isContacted(batch.targets[0]!.jobId), false);
    assert.equal(state.isContacted('old-done'), true);
    assert.equal(state.isContacted('old-unknown'), true);
    assert.equal(state.snapshot().contactedToday, before.contactedToday);
    assert.equal(state.snapshot().contactedCount, before.contactedCount);
    await new Executor(state,site).start();
    assert.equal(state.snapshot().batch!.status,'done');
    assert.deepEqual([f.contacts,f.quotaDismissals,f.sends],[1,1,[]]);
  } finally {state.close();await site.close();await f.close();}
});
