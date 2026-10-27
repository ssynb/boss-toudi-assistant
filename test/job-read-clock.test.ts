import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openState } from '../src/state.ts';
import { tempDir } from './helpers.ts';

test('换日后时钟回到已用尽的北京时间日期，不会重新获得300个名额', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-26T07:00:00Z') });
  const state = openState(path.join(tempDir('boss-read-clock-'), 'state.sqlite'));
  try {
    for (let i = 0; i < 300; i++) state.recordJobRead();
    t.mock.timers.setTime(new Date('2026-10-26T16:00:00Z').getTime());
    state.recordJobRead();
    assert.equal(state.snapshot().jobReadsToday, 1);
    t.mock.timers.setTime(new Date('2026-10-26T15:59:59Z').getTime());
    assert.equal(state.snapshot().jobReadsToday, 300);
    assert.throws(() => state.recordJobRead(), /今日浏览上限/);
  } finally { state.close(); t.mock.timers.reset(); }
});
