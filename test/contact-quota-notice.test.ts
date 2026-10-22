import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBossSite } from '../src/boss.ts';
import type { Target } from '../src/contracts.ts';
import { bossBrowser, draft, localBrowser, startBoss } from './boss-fixture.ts';

for (const quotaNotice of ['continue','not-contacted','unknown'] as const) {
  test(`联系后额度提示：${quotaNotice}`, async () => {
    const f=await startBoss({quotaNotice});
    const browser=localBrowser('contact-quota');
    const site=createBossSite(bossBrowser(browser,f));
    try {
      const target=draft() as Target;
      assert.equal((await site.openJob(target)).kind,'canContact');
      const result=await site.contact(target) as {ok:boolean;evidence:string;notContacted?:true};
      assert.equal(result.ok,quotaNotice==='continue',result.evidence);
      if(quotaNotice==='unknown') {
        assert.equal(result.notContacted,undefined);
        assert.equal(f.quotaDismissals,0,'未知弹窗不能自动关闭');
      } else {
        assert.equal(result.notContacted,quotaNotice==='not-contacted'?true:undefined);
        assert.match(result.evidence,/120/);
        assert.match(result.evidence,/30/);
        assert.equal(f.quotaDismissals,1);
      }
      assert.equal(f.contacts,1,'不能再次点击立即沟通');
      assert.deepEqual(f.sends,[]);
    } finally {await site.close();await f.close();}
  });
}
