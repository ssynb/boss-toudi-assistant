import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { openState } from '../src/state.ts';
import { createBossSite } from '../src/boss.ts';
import type { Browser } from '../src/browser.ts';
import type { Target } from '../src/contracts.ts';
import { tempDir } from './helpers.ts';

const draft = (id: string) => ({ jobId: id, company: '同一公司', title: id, salary: '', url: `https://www.zhipin.com/job_detail/${id}.html`, reason: '', greeting: '你好' });

test('旧批次的批准不能用于替换后的新批次，重启后也不能', () => {
  const file = path.join(tempDir('boss-version-'), 'state.sqlite');
  let state = openState(file);
  const old = state.replaceBatch([draft('A')]);
  state.patchTarget(old.targets[0]!.id, { greeting: '修改后' });
  const reviewedVersion = state.snapshot().batch!.version;
  state.close();
  state = openState(file);
  state.replaceBatch([draft('B')]);
  assert.throws(() => state.approve(old.version), { code: 'stale_version' });
  assert.throws(() => state.approve(reviewedVersion), { code: 'stale_version' });
  assert.throws(() => state.beginRun(), { code: 'not_startable' });
  state.approve(state.snapshot().batch!.version);
  assert.equal(state.beginRun().targets[0]!.jobId, 'B');
  state.close();
});

/** 浏览器进程接缝：执行生产适配器的取值脚本，DOM 只提供站点字段，不伪造脚本返回对象。 */
function browserFixture() {
  let url = 'https://www.zhipin.com/job_detail/A.html';
  let chatJob = 'A';
  let recruiter = 'hrA';
  const messages = ['已有招呼'];
  const writes: string[] = [];
  const node = (text: string, href?: string) => ({ textContent: text, innerText: text, href, getClientRects: () => [1], checkVisibility: () => true });
  const href = (kind: string, id: string) => `https://www.zhipin.com/${kind}/${id}.html`;
  const document = {
    title: 'BOSS直聘',
    querySelector(selector: string) {
      if (selector === '.chat-conversation .company-name') return node('同一公司');
      if (selector === '.chat-conversation .message-list') return node('消息');
      if (selector === '.chat-conversation a[href*="/job_detail/"]') return node('岗位', href('job_detail', chatJob));
      if (selector === '.chat-conversation a[href*="/boss_detail/"]') return node('招聘者', href('boss_detail', recruiter));
      if (selector === 'a[href*="/boss_detail/"]') return node('招聘者', href('boss_detail', 'hrA'));
      return null;
    },
    querySelectorAll(selector: string) {
      if (selector === '.nav-figure, .user-nav .user-name') return [node('用户')];
      if (selector === '[class*="item-myself"]' || selector === '.chat-conversation .message-list [class*="item-myself"]') return messages.map(x => node(x));
      return [];
    },
  };
  const browser = {
    isOpen: true,
    async eval(expression: string) { return vm.runInNewContext(expression, { document, location: new URL(url), URL }); },
    async open(next: string) { url = next; },
    async waitFor() {},
    async snapshot(scope?: string) {
      if (scope === '.chat-conversation') return { refs: { input: { role: 'textbox', name: '消息' } } };
      return { refs: { contact: { role: 'button', name: '立即沟通' } } };
    },
    async click(ref: string) {
      writes.push(`click:${ref}`);
      if (ref === 'contact') url = 'https://www.zhipin.com/web/geek/chat';
    },
    async fill(_ref: string, text: string) { writes.push('fill'); messages.push(text); },
    async press(key: string) { writes.push(`press:${key}`); },
    async close() {},
  } as unknown as Browser;
  return { browser, writes, switchChat(job: string, hr: string) { chatJob = job; recruiter = hr; } };
}

const target: Target = { ...draft('A'), id: 'targetA', removed: false, steps: { contact: 'done', greeting: 'todo' }, evidence: '', updatedAt: '' };

async function contact(f: ReturnType<typeof browserFixture>) {
  const site = createBossSite(f.browser);
  assert.equal((await site.openJob(target)).kind, 'canContact');
  assert.equal((await site.contact(target)).ok, true);
  f.writes.length = 0;
  return site;
}

for (const [job, hr] of [['B', 'hrA'], ['A', 'hrB']]) {
  test(`同公司会话切换为 ${job}/${hr} 时拒绝发招呼`, async () => {
    const f = browserFixture();
    const site = await contact(f);
    f.switchChat(job!, hr!);
    await assert.rejects(site.sendGreeting(target, '你好'));
    assert.deepEqual(f.writes, []);
  });
}

test('点击沟通后进入错误招聘者会话不算联系已核实', async () => {
  const f = browserFixture();
  const site = createBossSite(f.browser);
  await site.openJob(target);
  f.switchChat('A', 'hrB');
  assert.equal((await site.contact(target)).ok, false);
});

test('正确岗位和招聘者的会话可以发送原文', async () => {
  const f = browserFixture();
  const site = await contact(f);
  assert.equal((await site.sendGreeting(target, '你好')).ok, true);
  assert.deepEqual(f.writes, ['fill', 'press:Enter']);
});
