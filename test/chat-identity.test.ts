import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { createBossSite } from '../src/boss.ts';
import type { Browser } from '../src/browser.ts';
import type { Target } from '../src/contracts.ts';
import { openState } from '../src/state.ts';
import { tempDir } from './helpers.ts';

const identity = { kind: 'chatId' as const, jobId: 'jobA', recruiterId: 'bossA' };
const target = { id: 'target', jobId: 'jobA', url: 'https://www.zhipin.com/job_detail/jobA.html', company: '公司', title: '岗位', salary: '', reason: '', greeting: '你好', removed: false, evidence: '', updatedAt: '', steps: { contact: 'done', greeting: 'todo' }, contactIdentity: identity } as Target;

function fixture() {
  let url = target.url;
  const selected = { encryptJobId: 'jobA', encryptBossId: 'bossA' };
  const header = { ...selected, companyName: '公司' };
  const record = { selectedFriend$: selected, conversation$: header, loading: false, history: false, list$: [{ isSelf: true }] };
  let redirect = 'https://www.zhipin.com/web/geek/chat?id=bossA&jobId=jobA&securityId=not-an-identity';
  const writes: string[] = [];
  const document = {
    title: 'BOSS',
    querySelector(selector: string) {
      if (selector === '.chat-conversation') return { __vue__: { selectedFriend$: selected } };
      if (selector === '.chat-conversation .top-info-content') return { __vue__: { conversation$: header } };
      if (selector === '.chat-conversation .chat-record') return { __vue__: record };
      return null;
    },
    querySelectorAll(selector: string) {
      if (selector === '.nav-figure, .user-nav .user-name') return [{ checkVisibility: () => true }];
      if (selector === '.btn-startchat[redirect-url]') return [{ getAttribute: () => redirect }, { getAttribute: () => redirect }];
      if (selector === '.chat-conversation .chat-record .item-myself') return [{ innerText: '已读\n你好', querySelector: () => ({ innerText: '你好' }) }];
      return [];
    },
  };
  const browser = {
    isOpen: true,
    async open(next: string) { url = next; },
    async waitFor() {},
    async snapshot() { return { refs: { contact: { role: 'link', name: '立即沟通' } } }; },
    async eval(expression: string) { return vm.runInNewContext(expression, { document, location: new URL(url), URL }); },
    async click() { writes.push('contact'); url = 'https://www.zhipin.com/web/geek/chat'; },
    async fill() { writes.push('fill'); },
    async press() { writes.push('send'); },
  } as unknown as Browser;
  return { browser, selected, header, record, writes, redirect(value: string) { redirect = value; }, chat() { url = 'https://www.zhipin.com/web/geek/chat'; } };
}

test('真实页面没有招聘者链接时，从沟通入口核实岗位及招聘者 ID，联系后返回明确身份', async () => {
  const f = fixture();
  const site = createBossSite(f.browser);
  assert.equal((await site.openJob(target)).kind, 'canContact');
  assert.deepEqual(f.writes, []);
  assert.deepEqual((await site.contact(target)).identity, identity);
});

for (const redirect of ['https://www.zhipin.com/web/geek/chat?id=bossA&jobId=jobB', 'https://other.example/web/geek/chat?id=bossA&jobId=jobA', 'https://www.zhipin.com/web/geek/chat?jobId=jobA']) {
  test(`拒绝不完整或非目标入口 ${redirect}`, async () => {
    const f = fixture(); f.redirect(redirect);
    assert.equal((await createBossSite(f.browser).openJob(target)).kind, 'blocked');
    assert.deepEqual(f.writes, []);
  });
}

test('点击前招聘者变化时不能添加联系人', async () => {
  const f = fixture(); const site = createBossSite(f.browser);
  assert.equal((await site.openJob(target)).kind, 'canContact');
  f.redirect('https://www.zhipin.com/web/geek/chat?id=bossB&jobId=jobA');
  assert.equal((await site.contact(target)).ok, false);
  assert.deepEqual(f.writes, []);
});

test('真实会话结构只读取本方消息，切换会话或详情未同步时禁止发送前读取', async () => {
  const f = fixture(); f.chat(); const site = createBossSite(f.browser);
  assert.equal((await site.readChat(target)).ourMessages, 1);
  assert.deepEqual(f.writes, []);
  f.selected.encryptBossId = 'bossB';
  await assert.rejects(site.readChat(target), /身份/);
  f.selected.encryptBossId = 'bossA'; f.header.encryptJobId = 'jobB';
  await assert.rejects(site.sendGreeting(target, '你好'), /身份/);
  assert.deepEqual(f.writes, []);
});

test('消息加载未完成时不能将列表当作发送证据', async () => {
  const f = fixture(); f.chat(); f.record.loading = true;
  await assert.rejects(createBossSite(f.browser).readChat(target), /消息|加载/);
});

test('ID 身份重启后保留，旧 URL 身份仍可恢复且联系账本不丢失', () => {
  const file = path.join(tempDir('boss-chat-identity-'), 'state.sqlite');
  let state = openState(file);
  const batch = state.replaceBatch([target, { ...target, jobId: 'old', url: 'https://www.zhipin.com/job_detail/old.html' }]);
  const legacy = { jobId: 'old', recruiterUrl: 'https://www.zhipin.com/boss_detail/old.html' };
  state.setStep(batch.targets[0]!, 'contact', 'done', '', identity);
  state.setStep(batch.targets[1]!, 'contact', 'done', '', legacy);
  state.close(); state = openState(file);
  assert.deepEqual(state.snapshot().batch!.targets.map(t => t.contactIdentity), [identity, legacy]);
  assert.equal(state.snapshot().contactedCount, 2);
  state.close();
});
