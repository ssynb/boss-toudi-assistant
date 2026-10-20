import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openState, type State } from '../src/state.ts';
import { Executor, type WriteSite } from '../src/executor.ts';
import type { Target } from '../src/contracts.ts';

const job = (id: string) => ({
  jobId: id,
  company: `公司${id}`,
  title: `岗位${id}`,
  salary: '20-30K',
  url: `https://www.zhipin.com/job_detail/${id}.html`,
  reason: '匹配',
  greeting: `你好，我对岗位${id}感兴趣`,
});

function tempDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'boss-batch-')), 'state.sqlite');
}

function fakeSite(over: Partial<WriteSite> = {}) {
  const calls: string[] = [];
  const site: WriteSite = {
    async openJob(t) {
      calls.push(`open:${t.jobId}`);
      return { kind: 'canContact', evidence: '页面有「立即沟通」' };
    },
    async contact(t) {
      calls.push(`contact:${t.jobId}`);
      return { ok: true, evidence: '会话已打开' };
    },
    async readChat(t) {
      calls.push(`read:${t.jobId}`);
      return { ourMessages: 0, evidence: '会话里没有本方消息' };
    },
    async sendGreeting(t) {
      calls.push(`greet:${t.jobId}`);
      return { ok: true, evidence: '招呼已出现在会话中' };
    },
    ...over,
  };
  return { site, calls };
}

function approvedState(ids: string[], dbFile = tempDb()): State {
  const state = openState(dbFile);
  const batch = state.replaceBatch(ids.map(job));
  state.approve(batch.version);
  return state;
}

const target = (state: State, jobId: string): Target => {
  const t = state.snapshot().batch?.targets.find((x) => x.jobId === jobId);
  assert.ok(t, `target ${jobId}`);
  return t;
};

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'no error';
};

const asyncCodeOf = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'no error';
};

test('未批准的草案不能执行，站点上不发生任何动作', async () => {
  const state = openState(tempDb());
  state.replaceBatch([job('a')]);
  const { site, calls } = fakeSite();
  assert.equal(await asyncCodeOf(() => new Executor(state, site).start()), 'not_startable');
  assert.deepEqual(calls, []);
});

test('批准必须针对当前版本', () => {
  const state = openState(tempDb());
  const batch = state.replaceBatch([job('a')]);
  assert.equal(codeOf(() => state.approve(batch.version - 1)), 'stale_version');
  state.approve(batch.version);
  assert.equal(state.snapshot().batch?.status, 'approved');
});

const invalidating: Array<[string, (s: State) => void]> = [
  ['改招呼原文', (s) => s.patchTarget(target(s, 'a').id, { greeting: '改过的招呼' })],
  ['移除目标', (s) => s.patchTarget(target(s, 'a').id, { removed: true })],
  ['改具体要求', (s) => s.saveInputs({ requirements: '上海后端，薪资不限', resume: { text: null } })],
  ['改简历正文', (s) => s.saveInputs({ requirements: '', resume: { text: '新的简历正文' } })],
  ['删除简历', (s) => s.saveInputs({ requirements: '', resume: { file: null, text: null } })],
];

for (const [name, mutate] of invalidating) {
  test(`${name}使已有批准失效，执行被拒绝`, async () => {
    const state = approvedState(['a']);
    const before = state.snapshot().batch!.version;
    mutate(state);
    const batch = state.snapshot().batch!;
    assert.equal(batch.status, 'draft');
    assert.ok(batch.version > before);
    const { site, calls } = fakeSite();
    assert.equal(await asyncCodeOf(() => new Executor(state, site).start()), 'not_startable');
    assert.deepEqual(calls, []);
  });
}

test('执行中拒绝修改具体要求、简历与批次', async () => {
  const state = approvedState(['a']);
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    const { site } = fakeSite({
      contact: () =>
        new Promise((r) => {
          release = () => r({ ok: true, evidence: '会话已打开' });
          resolve();
        }),
    });
    void new Executor(state, site).start();
  });
  await entered;
  assert.equal(state.snapshot().batch?.status, 'running');
  for (const [name, mutate] of invalidating) {
    assert.equal(codeOf(() => mutate(state)), 'batch_running', name);
  }
  release();
});

test('执行只联系与发招呼，不发附件简历', async () => {
  const state = approvedState(['a']);
  const { site, calls } = fakeSite();
  await new Executor(state, site).start();
  assert.deepEqual(calls, ['open:a', 'contact:a', 'read:a', 'greet:a']);
  assert.deepEqual(target(state, 'a').steps, { contact: 'done', greeting: 'done' });
  assert.equal(state.snapshot().batch?.status, 'done');
});

test('站点已自动发出默认招呼时不再发定制招呼', async () => {
  const state = approvedState(['a']);
  const { site, calls } = fakeSite({
    async readChat(t) {
      calls.push(`read:${t.jobId}`);
      return { ourMessages: 1, evidence: '会话里已有默认招呼语' };
    },
  });
  await new Executor(state, site).start();
  assert.ok(!calls.includes('greet:a'));
  assert.equal(target(state, 'a').steps.greeting, 'skipped');
});

test('之前批次已联系的岗位不会再次联系', async () => {
  const dbFile = tempDb();
  const first = approvedState(['a'], dbFile);
  await new Executor(first, fakeSite().site).start();

  const batch = first.replaceBatch([job('a'), job('b')]);
  first.approve(batch.version);
  const { site, calls } = fakeSite();
  await new Executor(first, site).start();
  assert.ok(!calls.some((c) => c.endsWith(':a')), calls.join(','));
  assert.equal(target(first, 'a').steps.contact, 'skipped');
  assert.equal(target(first, 'b').steps.greeting, 'done');
});

test('暂停在当前步骤完成后生效，继续时不重做已完成步骤', async () => {
  const state = approvedState(['a', 'b']);
  let executor!: Executor;
  const { site, calls } = fakeSite({
    async contact(t) {
      calls.push(`contact:${t.jobId}`);
      if (t.jobId === 'a') executor.pause();
      return { ok: true, evidence: '会话已打开' };
    },
  });
  executor = new Executor(state, site);
  await executor.start();
  assert.equal(state.snapshot().batch?.status, 'paused');
  assert.deepEqual(calls, ['open:a', 'contact:a']);
  assert.equal(target(state, 'a').steps.greeting, 'todo');

  await new Executor(state, site).start();
  assert.deepEqual(calls, ['open:a', 'contact:a', 'read:a', 'greet:a', 'open:b', 'contact:b', 'read:b', 'greet:b']);
  assert.equal(state.snapshot().batch?.status, 'done');
});

test('进程中断时进行中的步骤重启后记为未确认，且不再重试', async () => {
  const dbFile = tempDb();
  const crashed = approvedState(['a', 'b'], dbFile);
  const entered = new Promise<void>((resolve) => {
    const { site } = fakeSite({
      contact: () => {
        resolve();
        return new Promise(() => {});
      },
    });
    void new Executor(crashed, site).start();
  });
  await entered;
  crashed.close();

  const reopened = openState(dbFile);
  const batch = reopened.snapshot().batch!;
  assert.equal(batch.status, 'paused');
  assert.ok(batch.stopReason);
  assert.equal(target(reopened, 'a').steps.contact, 'unknown');

  const { site, calls } = fakeSite();
  await new Executor(reopened, site).start();
  assert.ok(!calls.some((c) => c.endsWith(':a')), calls.join(','));
  assert.notEqual(target(reopened, 'a').steps.greeting, 'done');
  assert.equal(target(reopened, 'b').steps.greeting, 'done');
});

test('发送结果无法核实时记为未确认并停下整批，继续时不重发', async () => {
  const state = approvedState(['a', 'b']);
  const first = fakeSite({
    async sendGreeting(t) {
      first.calls.push(`greet:${t.jobId}`);
      return { ok: false, evidence: '发送后会话里找不到这段话' };
    },
  });
  await new Executor(state, first.site).start();
  const batch = state.snapshot().batch!;
  assert.equal(batch.status, 'paused');
  assert.ok(batch.stopReason);
  assert.equal(target(state, 'a').steps.greeting, 'unknown');
  assert.ok(!first.calls.some((c) => c.endsWith(':b')));

  const second = fakeSite();
  await new Executor(state, second.site).start();
  assert.ok(!second.calls.some((c) => c.endsWith(':a')), second.calls.join(','));
  assert.equal(target(state, 'b').steps.greeting, 'done');
});

test('页面进入登录或安全验证时整批停下，未点击的目标保持待做', async () => {
  const state = approvedState(['a']);
  const { site, calls } = fakeSite({
    async openJob(t) {
      calls.push(`open:${t.jobId}`);
      return { kind: 'blocked', evidence: '安全验证 - BOSS直聘' };
    },
  });
  await new Executor(state, site).start();
  assert.equal(state.snapshot().batch?.status, 'paused');
  assert.equal(target(state, 'a').steps.contact, 'todo');
  assert.deepEqual(calls, ['open:a']);
});

test('发送前才出现本方消息时记为跳过，而非已发送或未知', async () => {
  const state = approvedState(['a']);
  try {
    const { site } = fakeSite({ sendGreeting: async () => ({ ok: true, skipped: true, evidence: '发送前已出现本方消息，未提交招呼' }) });
    await new Executor(state, site).start();
    assert.equal(target(state, 'a').steps.greeting, 'skipped');
    assert.equal(state.snapshot().batch!.status, 'done');
  } finally { state.close(); }
});
