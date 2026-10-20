import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createBossSite } from '../src/boss.ts';
import type { Browser } from '../src/browser.ts';
import type { Target } from '../src/contracts.ts';

for (const present of [true, false]) {
  test(`聊天弹层只选择岗位与招聘者同时匹配的已有会话（目标${present ? '存在' : '不存在'}）`, async () => {
    let url = 'https://www.zhipin.com/job_detail/jobA.html';
    let popup = false;
    let selected: { encryptJobId: string; encryptBossId: string } | undefined;
    const sources = [{ encryptJobId: 'jobB', encryptBossId: 'bossA' }, { encryptJobId: 'jobA', encryptBossId: 'bossB' }];
    if (present) sources.push({ encryptJobId: 'jobA', encryptBossId: 'bossA' });
    const actions: string[] = [];
    const document = {
      title: 'BOSS',
      querySelector(selector: string) {
        if (selector === '.startchat-dialog') return { checkVisibility: () => popup };
        if (selector === '.chat-conversation') return { __vue__: { selectedFriend$: selected } };
        const header = selected && { ...selected, companyName: '公司' };
        if (selector === '.chat-conversation .top-info-content') return { __vue__: { conversation$: header } };
        if (selector === '.chat-conversation .chat-record') return { __vue__: { selectedFriend$: selected, conversation$: header } };
        return null;
      },
      querySelectorAll(selector: string) {
        if (selector === '.nav-figure, .user-nav .user-name') return [{ checkVisibility: () => true }];
        if (selector === '.btn-startchat[redirect-url]') return [{ getAttribute: () => 'https://www.zhipin.com/web/geek/chat?id=bossA&jobId=jobA' }];
        if (selector === '.chat-user .chat-content li[role="listitem"]') return sources.map(source => ({ __vue__: { $props: { source } } }));
        return [];
      },
    };
    const evaluate = (expression: string) => vm.runInNewContext(expression, { document: { ...document, readyState: 'complete' }, location: new URL(url), URL });
    const browser = {
      isOpen: true,
      async open(next: string) { url = next; },
      async eval(expression: string) { return evaluate(expression); },
      async waitFor(expression: string) { if (!evaluate(expression)) throw new Error('等待目标会话未完成'); },
      async snapshot() { return { refs: { contact: { role: 'link', name: '立即沟通' } } }; },
      async click() { actions.push('contact'); popup = true; },
      async clickSelector(selector: string) { selected = sources[Number(selector.match(/nth-child\((\d+)\)/)![1]) - 1]; actions.push(`select:${selected!.encryptJobId}/${selected!.encryptBossId}`); },
    } as unknown as Browser;
    const site = createBossSite(browser);
    const target = { jobId: 'jobA', company: '公司', url } as Target;
    assert.equal((await site.openJob(target)).kind, 'canContact');
    assert.equal((await site.contact(target)).ok, present);
    assert.deepEqual(actions, present ? ['contact', 'select:jobA/bossA'] : ['contact']);
  });
}
