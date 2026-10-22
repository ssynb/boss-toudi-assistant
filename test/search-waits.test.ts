import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createBossSite, SiteBlockedError } from '../src/boss.ts';
import { localBrowser } from './boss-fixture.ts';

async function fixture(mode: string) {
  const browser = localBrowser('search-waits');
  const html = `<!doctype html><meta charset="utf-8"><title>本地搜索</title><div class="nav-figure">账号</div>
<div class="page-jobs-main"><ul>${mode === 'empty' ? '<div class="job-empty-box">无结果</div>' : mode === 'unrendered' || mode === 'detail' ? '' : '<li class="job-card-box" style="height:1600px"><a href="/job_detail/a.html">岗位A</a></li>'}</ul></div>
<script>
const root=document.querySelector('.page-jobs-main'),state=root.__vue__={pageVo:{page:1},hasMore:${mode !== 'empty'},loading:false,moreLoading:false};
let requested=false;
addEventListener('scroll',()=>{if(requested)return;requested=true;
 if(${JSON.stringify(mode)}==='stalled')return;
 state.moreLoading=true;
 setTimeout(()=>{
  if(['verify','login'].includes(${JSON.stringify(mode)})) {history.replaceState({},'',${mode === 'verify' ? "'/web/passport/zp/verify'" : "'/web/user/'"});document.title=${mode === 'verify' ? "'安全验证'" : "'登录'"};return;}
  if(${JSON.stringify(mode)}==='final-page') {state.pageVo.page=2;root.querySelector('ul').insertAdjacentHTML('beforeend','<li class="job-card-box"><a href="/job_detail/b.html">岗位B</a></li>');}
  state.hasMore=false;state.moreLoading=false;
 },50);
});
</script>`;
  const server=http.createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(html));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const map=(value:string)=>value.replaceAll('https://www.zhipin.com',origin);
  const mapped=new Proxy(browser,{get(o,k){
    if(k==='open')return (url:string)=>o.open(map(url));
    if(k==='waitFor')return (expr:string,...args:unknown[])=>Reflect.apply(o.waitFor,o,[map(expr),...args]);
    if(k==='eval')return async(expr:string)=>{const value=await o.eval(map(expr));return value===undefined?value:JSON.parse(JSON.stringify(value).replaceAll(origin,'https://www.zhipin.com'));};
    const v=Reflect.get(o,k,o);return typeof v==='function'?v.bind(o):v;
  }});
  return {site:createBossSite(mapped),async close(){await browser.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}

for (const [mode,page,expected] of [['end-without-page',2,[]],['final-page',2,['b']],['final-page',3,[]],['empty',1,[]]] as const) {
  test(`搜索终态无需页码继续推进：${mode}/${page}`,async()=>{
    const f=await fixture(mode);try{assert.deepEqual((await f.site.search({keyword:'AI Agent 开发',city:'深圳',page})).map(x=>x.jobId),expected);}finally{await f.close();}
  });
}
for (const mode of ['verify','login'] as const) {
  test(`分页途中出现${mode}返回站点阻塞而不是等待超时`,async()=>{
    const f=await fixture(mode);try{
      await assert.rejects(f.site.search({keyword:'AI Agent 开发',city:'深圳',page:2}),e=>e instanceof SiteBlockedError&&e.state.page===(mode==='verify'?'verify':'loggedOut'));
    }finally{await f.close();}
  });
}
for (const [mode,step] of [['stalled','分页加载'],['unrendered','搜索结果渲染'],['detail','JD详情']] as const) {
  test(`真实等待失败标明步骤：${step}`,async()=>{
    const f=await fixture(mode);try{
      await assert.rejects(mode==='detail'?f.site.jobDetail({jobId:'a',url:'https://www.zhipin.com/job_detail/a.html'}):f.site.search({keyword:'AI Agent 开发',city:'深圳',page:mode==='stalled'?2:1}),new RegExp(step));
    }finally{await f.close();}
  });
}
