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
    state.close();
    state = openState(file);
    assert.deepEqual(state.snapshot().batch!.targets[0]!.steps,{contact:'failed',greeting:'skipped'});
    await new Executor(state,site).start();
    assert.equal(state.snapshot().batch!.status,'done');
    assert.deepEqual([f.contacts,f.quotaDismissals,f.sends],[1,1,[]]);
  } finally {state.close();await site.close();await f.close();}
});
