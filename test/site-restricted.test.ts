import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createBossSite, SiteBlockedError } from '../src/boss.ts';
import { localBrowser } from './boss-fixture.ts';

const warning='访问受限。您的账户存在异常行为，已暂时被限制访问！将于 2026-10-25 08:10 恢复正常。请勿频繁提交刷新请求';
async function fixture(mode:'path'|'text'|'paging'|'no-time') {
  const browser=localBrowser('restricted');
  const opens:string[]=[];let scrolls=0;
  const blocked=`<!doctype html><title>站点提示</title><div class="nav-figure">账号</div><a href="/web/user/">登录</a><main>${mode==='no-time'?'':warning}</main>`;
  const initial=`<!doctype html><div class="nav-figure">账号</div><div class="page-jobs-main"><ul><li class="job-card-box" style="height:1600px"><a href="/job_detail/a.html">岗位</a></li></ul></div><script>
  document.querySelector('.page-jobs-main').__vue__={pageVo:{page:1},loading:false,moreLoading:false,hasMore:true};
  addEventListener('scroll',()=>{document.body.innerText=${JSON.stringify(warning)};},{once:true});</script>`;
  const server=http.createServer((req,res)=>{
    if((mode==='path'||mode==='no-time')&&!req.url!.startsWith('/web/passport/zp/403'))return res.writeHead(302,{location:'/web/passport/zp/403.html?code=32'}).end();
    res.writeHead(200,{'content-type':'text/html;charset=utf-8'}).end(mode==='paging'?initial:blocked);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const map=(s:string)=>s.replaceAll('https://www.zhipin.com',origin);
  const mapped=new Proxy(browser,{get(o,k){
    if(k==='open')return (url:string)=>{opens.push(new URL(url).pathname);return o.open(map(url));};
    if(k==='scrollToBottom')return ()=>{scrolls++;return o.scrollToBottom();};
    if(k==='waitFor')return (expr:string,step?:string,timeout?:number)=>o.waitFor(map(expr),step,timeout);
    if(k==='eval')return async(expr:string)=>JSON.parse(JSON.stringify(await o.eval(map(expr))).replaceAll(origin,'https://www.zhipin.com'));
    const v=Reflect.get(o,k,o);return typeof v==='function'?v.bind(o):v;
  }});
  return {browser,site:createBossSite(mapped),opens,get scrolls(){return scrolls;},async close(){await browser.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}

for(const mode of ['path','text','no-time'] as const) {
  test(`限制访问${mode}优先于登录或账号信号，打开后不再导航或刷新`,async()=>{
    const f=await fixture(mode);
    try {
      const opened=await f.site.open();
      assert.equal(opened.page,'restricted');
      assert.match(opened.message!,/勿.*刷新/);
      if(mode!=='no-time')assert.match(opened.message!,/2026-10-25 08:10/);
      else assert.doesNotMatch(opened.message!,/2026-/);
      assert.equal((await f.site.status()).page,'restricted');
      const attempts=f.opens.length;
      await assert.rejects(f.site.jobDetail({jobId:'a',url:'https://www.zhipin.com/job_detail/a.html'}),e=>e instanceof SiteBlockedError&&e.state.page==='restricted'&&/勿.*刷新/.test(e.message));
      assert.equal((await f.site.open()).page,'restricted');
      assert.equal(f.opens.length,attempts,'检测限制后不能再导航');
    } finally {await f.close();}
  });
}

for(const mode of ['path','paging'] as const) {
  test(`搜索${mode}遇限制立即停止，不执行下一次滚动或导航`,async()=>{
    const f=await fixture(mode);
    try {
      await assert.rejects(f.site.search({keyword:'前端',city:'深圳',page:2}),e=>e instanceof SiteBlockedError&&e.state.page==='restricted'&&e.message.includes('2026-10-25 08:10')&&/勿.*刷新/.test(e.message));
      assert.equal(f.scrolls,mode==='paging'?1:0);
      assert.equal(f.opens.length,1);
      await assert.rejects(f.site.search({keyword:'前端',city:'深圳',page:1}),e=>e instanceof SiteBlockedError&&e.state.page==='restricted');
      assert.equal(f.opens.length,1);
    } finally {await f.close();}
  });
}
