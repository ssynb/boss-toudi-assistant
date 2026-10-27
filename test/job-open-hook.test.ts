import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBossSite, SiteBlockedError } from '../src/boss.ts';
import type { Target } from '../src/contracts.ts';
import { bossBrowser, draft, localBrowser, startBoss } from './boss-fixture.ts';

test('岗位导航前同步计数，复用当前岗位和搜索不计数',async()=>{
  const f=await startBoss();const browser=localBrowser('job-open-hook');
  const observed:number[]=[];
  const site=createBossSite(bossBrowser(browser,f),()=>{observed.push(f.jobVisits.length);});
  try {
    const target=draft() as Target;
    await site.jobDetail(target);
    assert.deepEqual(observed,[0]);
    assert.equal((await site.openJob(target)).kind,'canContact');
    assert.deepEqual(f.jobVisits,['jobA']);
    assert.deepEqual(observed,[0]);
    await site.jobDetail({jobId:'other',url:'https://www.zhipin.com/job_detail/other.html'});
    await site.openJob(target);
    assert.deepEqual(f.jobVisits,['jobA','other','jobA']);
    assert.deepEqual(observed,[0,1,2]);
    await site.search({keyword:'前端',city:'深圳',page:1});
    assert.deepEqual(observed,[0,1,2]);
  }finally{await site.close();await f.close();}
});

for(const operation of ['jobDetail','openJob'] as const)for(const error of [new Error('额度不足'),new SiteBlockedError({page:'restricted',url:null,message:'回调拒绝'})]) {
  test(`${operation}回调抛出${error.name}/${error.message}时原样拒绝且不导航`,async()=>{
    const f=await startBoss();const browser=localBrowser('job-open-hook-error');let calls=0;
    const site=createBossSite(bossBrowser(browser,f),()=>{calls++;throw error;});
    try {
      await assert.rejects(site[operation](draft() as Target),e=>e===error);
      assert.equal(calls,1);
      assert.deepEqual(f.jobVisits,[]);
      assert.equal(browser.isOpen,false);
    }finally{await site.close();await f.close();}
  });
}
