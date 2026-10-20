import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { createBossSite } from '../src/boss.ts';
import type { Browser } from '../src/browser.ts';
import type { Target } from '../src/contracts.ts';
import { openState } from '../src/state.ts';
import { tempDir } from './helpers.ts';
import { bossBrowser, localBrowser, message, startBoss, TARGET, type Message, type Scenario } from './boss-fixture.ts';

const identity = { kind: 'chatId' as const, jobId: 'jobA', recruiterId: 'bossA' };
const target = { id: 'target', jobId: 'jobA', url: 'https://www.zhipin.com/job_detail/jobA.html', company: '公司', title: '岗位', salary: '', reason: '', greeting: '你好', removed: false, evidence: '', updatedAt: '', steps: { contact: 'done', greeting: 'todo' }, contactIdentity: identity } as Target;

function fixture() {
  let redirect = 'https://www.zhipin.com/web/geek/chat?id=bossA&jobId=jobA&securityId=not-an-identity';
  const writes: string[] = [];
  const document = {
    title: 'BOSS',
    querySelector: () => null,
    querySelectorAll(selector: string) {
      if (selector === '.nav-figure, .user-nav .user-name') return [{ checkVisibility: () => true }];
      if (selector === '.btn-startchat[redirect-url]') return [{ getAttribute: () => redirect }, { getAttribute: () => redirect }];
      return [];
    },
  };
  const browser = {
    isOpen: true,
    async open() {},
    async waitFor() {},
    async snapshot() { return { refs: { contact: { role: 'link', name: '立即沟通' } } }; },
    async eval(expression: string) { return vm.runInNewContext(expression, { document: { ...document, readyState: 'complete' }, location: new URL(target.url), URL }); },
    async click() { writes.push('contact'); },
  } as unknown as Browser;
  return { browser, writes, redirect(value: string) { redirect = value; } };
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


// ---- 真实 CloakBrowser + 本地合成会话：历史完成事实来自被动响应，当前身份与新到消息来自 DOM ----

const browser = localBrowser('chat-history');
after(() => browser.close());

async function existing(scenario: Partial<Scenario>, history: Message[] = []) {
  const f = await startBoss({ friends: [{ ...TARGET, jobId: 'jobB' }, TARGET], ...scenario });
  f.history.set(TARGET.bossId, history);
  return { f, site: createBossSite(bossBrowser(browser, f)) };
}

const bossOnly = [message(1, false, '你好'), message(2, false, '在吗'), message(3, false, '方便聊聊')];

for (const [name, scenario, history, expected, pages] of [
  ['零记录：首批成功空数组且明确没有更多', {}, [], 0, [1]],
  ['仅对方消息的多页历史：游标连续并到达结束', { pageSize: 2 }, bossOnly, 0, [1, 2]],
  ['较早一页里的本方消息被计入', { pageSize: 2 }, [message(1, true, '早先的招呼'), ...bossOnly.slice(1), message(4, false, '最新')], 1, [1, 2]],
] as const) {
  test(`进入已有会话后按完整历史判定：${name}`, async () => {
    const { f, site } = await existing(scenario, [...history]);
    try {
      assert.equal((await site.readChat(target)).ourMessages, expected);
      assert.deepEqual(f.historyRequests.filter(r => r.bossId === TARGET.bossId).map(r => r.page), pages);
      assert.equal(f.contacts, 0);
      assert.deepEqual(f.sends, []);
    } finally { await f.close(); }
  });
}

const ok = (messages: unknown[], hasMore: unknown = false) => ({ status: 200, body: { code: 0, zpData: { messages, hasMore, minMsgId: 0 } } });
for (const [name, scenario] of [
  ['HTTP 失败', { history: () => ({ status: 500, body: { code: 0, zpData: { messages: [], hasMore: false } } }) }],
  ['业务码失败', { history: () => ({ status: 200, body: { code: 7, zpData: { messages: [], hasMore: false } } }) }],
  ['缺少消息数组', { history: () => ({ status: 200, body: { code: 0, zpData: { hasMore: false } } }) }],
  ['没有明确的结束标记', { history: () => ({ status: 200, body: { code: 0, zpData: { messages: [message(1, false, '你好')] } } }) }],
  ['网络中断', { history: () => 'drop' as const }],
  ['首批为空却声称还有更多', { history: () => ok([], true) }],
  ['本方消息发往其他招聘者', { history: () => ok([message(1, true, '发错', 99)]) }],
  ['第二页游标不连续', { pageSize: 2, cursorGap: true }],
  ['后续页只有重复消息', { pageSize: 2, history: (q: { page: number }) => q.page === 2 ? ok([message(3, false, '方便聊聊')], true) : undefined }],
] as const) {
  test(`历史证据不完整时不能当作零消息：${name}`, async () => {
    const { f, site } = await existing(scenario as Partial<Scenario>, [...bossOnly]);
    try {
      await assert.rejects(site.readChat(target), /历史|归属|游标|进展/);
      await assert.rejects(site.sendGreeting(target, '定制招呼'), /历史|归属|游标|进展/);
      assert.deepEqual(f.sends, []);
    } finally { await f.close(); }
  });
}

test('读完历史后被切到同一招聘者的其他岗位会话：发送前重新进入目标会话', async () => {
  const { f, site } = await existing({}, [message(1, false, '你好')]);
  try {
    assert.equal((await site.readChat(target)).ourMessages, 0);
    await browser.clickSelector('.chat-user .chat-content li[role="listitem"]:nth-child(1)');
    const result = await site.sendGreeting(target, '定制招呼');
    assert.equal(result.ok, true, result.evidence);
    assert.deepEqual(f.sends, ['定制招呼']);
    assert.equal(await browser.eval('document.querySelector(".chat-conversation").__vue__.selectedFriend$.encryptJobId'), TARGET.jobId);
  } finally { await f.close(); }
});

test('历史读完后迟到的本方默认招呼：填写前跳过，不填写', async () => {
  const { f, site } = await existing({ late: 'after-history' }, [message(1, false, '你好')]);
  try {
    assert.equal((await site.readChat(target)).ourMessages, 0);
    await browser.waitFor('Boolean(document.querySelector(".item-myself"))');
    const result = await site.sendGreeting(target, '定制招呼');
    assert.equal(result.skipped, true, result.evidence);
    assert.equal(await browser.eval('document.getElementById("chat-input").innerText'), '');
    assert.deepEqual(f.sends, []);
  } finally { await f.close(); }
});

test('填写时到达的本方默认招呼：提交前跳过，不按 Enter', async () => {
  const { f, site } = await existing({ late: 'on-input' }, [message(1, false, '你好')]);
  try {
    const result = await site.sendGreeting(target, '定制招呼');
    assert.equal(result.skipped, true, result.evidence);
    assert.deepEqual(f.sends, []);
  } finally { await f.close(); }
});

for (const [name, scenario, pattern] of [
  ['填写后输入框内容不是批准原文', { mangleInput: true }, /原文/],
  ['填写后切到了其他会话', { switchOnInput: true }, /身份|会话/],
] as const) {
  test(`提交前复核失败不按 Enter：${name}`, async () => {
    const { f, site } = await existing(scenario, [message(1, false, '你好')]);
    try {
      const result = await site.sendGreeting(target, '定制招呼').catch((e: Error) => ({ ok: false, evidence: e.message }));
      assert.equal(result.ok, false);
      assert.match(result.evidence, pattern);
      assert.deepEqual(f.sends, []);
    } finally { await f.close(); }
  });
}

for (const recruiterId of ['bossA', 'boss~A', 'boss.A']) {
  test(`招聘者 ID ${recruiterId} 按原值提取、联系后精确进入会话`, async () => {
    const f = await startBoss({ target: { ...TARGET, bossId: recruiterId }, friends: [{ ...TARGET, jobId: 'jobB', bossId: recruiterId }] });
    const site = createBossSite(bossBrowser(browser, f));
    const candidate = { ...target, contactIdentity: undefined, steps: { contact: 'todo', greeting: 'todo' } } as Target;
    try {
      assert.equal((await site.openJob(candidate)).kind, 'canContact');
      const contacted = await site.contact(candidate);
      assert.equal(contacted.ok, true, contacted.evidence);
      assert.deepEqual(contacted.identity, { ...identity, recruiterId });
      assert.equal((await site.readChat({ ...candidate, contactIdentity: contacted.identity })).ourMessages, 0);
      assert.equal(f.contacts, 1);
    } finally { await f.close(); }
  });
}

// ---- 岗位页显示「继续沟通」：不点击，只按真实 ID 进入已有会话，用完整历史区分已发送与仅打开过 ----

const candidate = { ...target, contactIdentity: undefined, steps: { contact: 'todo', greeting: 'todo' } } as Target;

test('继续沟通且历史里已有本方消息：返回已联系，不点击', async () => {
  const { f, site } = await existing({}, [message(1, true, '早先的招呼'), message(2, false, '你好')]);
  try {
    assert.equal((await site.openJob(candidate)).kind, 'alreadyContacted');
    assert.equal(f.contacts, 0);
    assert.deepEqual(f.sends, []);
  } finally { await f.close(); }
});

test('继续沟通且完整历史证明本方零消息：返回已有会话与身份，不点击，可只读后发送', async () => {
  const { f, site } = await existing({}, [message(1, false, '你好')]);
  try {
    const opened = await site.openJob(candidate) as { kind: string; identity?: unknown };
    assert.equal(opened.kind, 'existingConversation');
    assert.deepEqual(opened.identity, identity);
    assert.equal(f.contacts, 0);
    const saved = { ...candidate, contactIdentity: identity } as Target;
    assert.equal((await site.readChat(saved)).ourMessages, 0);
    const sent = await site.sendGreeting(saved, '定制招呼');
    assert.equal(sent.ok, true, sent.evidence);
    assert.deepEqual([f.contacts, f.sends], [0, ['定制招呼']]);
  } finally { await f.close(); }
});

test('继续沟通但历史不能完整证明：阻塞，不点击也不当作可联系', async () => {
  const { f, site } = await existing({ history: () => ({ status: 500, body: {} }) }, []);
  try {
    assert.equal((await site.openJob(candidate)).kind, 'blocked');
    assert.equal(f.contacts, 0);
    assert.equal((await site.contact(candidate)).ok, false);
    assert.equal(f.contacts, 0);
  } finally { await f.close(); }
});
