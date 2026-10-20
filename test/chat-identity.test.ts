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

function fixture(recruiterId = 'bossA') {
  let url = target.url;
  const selected = { encryptJobId: 'jobA', encryptBossId: recruiterId, friendId: 8, friendSource: 0 };
  const header = { ...selected, companyName: '公司' };
  const record = { selectedFriend$: selected, conversation$: header, boss: { ...selected }, loading: false, history: false, isToTop: true, msgMinId: 1,
    page: 1, lastContentHeight: 100, $refs: { scrollContent: { clientHeight: 100 } },
    list$: [{ mid: 1, isSelf: true, fromId: 7, toId: 8, friendSource: 0 }] };
  const messageNode = (m: typeof record.list$[number]) => ({
    classList: { contains: (name: string) => name === (m.isSelf ? 'item-myself' : 'item-friend') },
    getAttribute: (name: string) => name === 'data-mid' ? String(m.mid) : null,
    querySelector: () => ({ innerText: '你好' }),
  });
  let redirect = `https://www.zhipin.com/web/geek/chat?id=${encodeURIComponent(recruiterId)}&jobId=jobA&securityId=not-an-identity`;
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
      if (selector === '.chat-conversation .chat-record .item-myself') return record.list$.filter(m => m.isSelf).map(messageNode);
      if (selector === '.chat-conversation .chat-record .im-list > .message-item') return record.list$.map(messageNode);
      if (selector === '.chat-conversation .message-controls .chat-input[contenteditable="true"]') return [{ checkVisibility: () => true }];
      return [];
    },
  };
  const browser = {
    isOpen: true,
    async open(next: string) { url = next; },
    async waitFor() {},
    async snapshot() { return { refs: { contact: { role: 'link', name: '立即沟通' } } }; },
    async eval(expression: string) { return vm.runInNewContext(expression, { document, location: new URL(url), URL, window: { _PAGE: { uid: 7 } } }); },
    async click() { writes.push('contact'); url = 'https://www.zhipin.com/web/geek/chat'; },
    async fill() { writes.push('fill'); },
    async press() { writes.push('send'); },
  } as unknown as Browser;
  return { browser, selected, header, record, writes, redirect(value: string) { redirect = value; }, chat() { url = 'https://www.zhipin.com/web/geek/chat'; } };
}

for (const recruiterId of ['bossA', 'boss~A', 'boss.A']) {
  test(`招聘者 ID ${recruiterId} 按原值提取并精确核对，不以字符白名单拒绝`, async () => {
    const f = fixture(recruiterId);
    const site = createBossSite(f.browser);
    const expected = { ...identity, recruiterId };
    const candidate = { ...target, contactIdentity: undefined };
    assert.equal((await site.openJob(candidate)).kind, 'canContact');
    assert.deepEqual(f.writes, []);
    assert.deepEqual((await site.contact(candidate)).identity, expected);
    const saved = { ...candidate, contactIdentity: expected };
    assert.equal((await site.readChat(saved)).ourMessages, 1);
    f.selected.encryptBossId = recruiterId + 'other';
    await assert.rejects(site.readChat(saved), /身份/);
    assert.deepEqual(f.writes, ['contact'], '不匹配时不能开始下一步');
  });
}

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


test('历史已完整加载且仅有对方消息时，可证明本方消息为零', async () => {
  const f = fixture(); f.chat();
  f.record.list$ = [{ mid: 1, isSelf: false, fromId: 8, toId: 7, friendSource: 0 }];
  assert.equal((await createBossSite(f.browser).readChat(target)).ourMessages, 0);
  assert.deepEqual(f.writes, []);
});

for (const condition of ['history', 'empty', 'ownership', 'stale-payload'] as const) {
  test(`没有可靠零消息证据时阻塞：${condition}`, async () => {
    const f = fixture(); f.chat();
    f.record.list$ = [{ mid: 1, isSelf: false, fromId: 8, toId: 7, friendSource: 0 }];
    if (condition === 'history') { f.record.history = true; f.record.isToTop = false; }
    if (condition === 'empty') { f.record.list$ = []; f.record.isToTop = false; f.record.msgMinId = 0; }
    if (condition === 'ownership') f.record.list$[0]!.isSelf = true;
    if (condition === 'stale-payload') {
      f.record.list$ = [{ mid: 1, isSelf: true, fromId: 7, toId: 8, friendSource: 0 }];
      f.record.boss.encryptBossId = 'other';
    }
    await assert.rejects(createBossSite(f.browser).readChat(target), condition === 'ownership' ? /归属/ : condition === 'stale-payload' ? /身份/ : /历史|证明/);
    assert.deepEqual(f.writes, []);
  });
}

for (const condition of ['history-response-before-render', 'multi-page-merge'] as const) {
  test(`历史完成标志不能早于消息合并放行：${condition}`, async () => {
    const f = fixture(); f.chat();
    f.record.list$ = [{ mid: 1, isSelf: false, fromId: 8, toId: 7, friendSource: 0 }];
    if (condition === 'history-response-before-render') f.record.lastContentHeight = 0;
    else f.record.page = 2;
    await assert.rejects(createBossSite(f.browser).readChat(target), /历史|渲染|证明/);
    assert.deepEqual(f.writes, []);
  });
}

for (const arrives of ['before-fill', 'before-submit'] as const) {
  test(`本方消息在${arrives}出现时跳过招呼，不按Enter`, async () => {
    const f = fixture(); f.chat();
    if (arrives === 'before-submit') f.record.list$ = [{ mid: 1, isSelf: false, fromId: 8, toId: 7, friendSource: 0 }];
    f.browser.fillSelector = async () => {
      f.writes.push('fill');
      f.record.list$.push({ mid: 2, isSelf: true, fromId: 7, toId: 8, friendSource: 0 });
    };
    const result = await createBossSite(f.browser).sendGreeting(target, '定制招呼');
    assert.equal(result.skipped, true);
    assert.deepEqual(f.writes, arrives === 'before-fill' ? [] : ['fill']);
  });
}
