import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createBossSite, SiteBlockedError } from '../src/boss.ts';
import { localBrowser } from './boss-fixture.ts';

for (const [name, markup, expected] of [
  ['隐藏说明拼在按钮文本后', '<a class="header-login-btn" href="/web/user/">登录/注册<span hidden> 登录注册后可以：沟通职位</span></a>', 'loggedOut'],
  ['仅有登录页链接', '<a href="/web/user/">进入账号<span hidden> 登录说明</span></a>', 'loggedOut'],
  ['首行是登录文字', '<button>登录/注册\n<span hidden>登录注册后可以：沟通职位</span></button>', 'loggedOut'],
  ['隐藏登录入口不能覆盖可见账号', '<div class="nav-figure">账号</div><a class="header-login-btn" href="/web/user/" hidden>登录/注册<span>说明</span></a>', 'ready'],
] as const) {
  test(`登录探测与打开浏览器共用可见入口判据：${name}`, async () => {
    const server=http.createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html;charset=utf-8'}).end('<!doctype html><title>本地首页</title>'+markup));
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const browser=localBrowser('login-entry');
    const map=(s:string)=>s.replaceAll('https://www.zhipin.com',origin);
    const mapped=new Proxy(browser,{get(o,k){
      if(k==='open')return (url:string)=>o.open(map(url));
      if(k==='waitFor')return (expr:string,step?:string,timeout?:number)=>o.waitFor(map(expr),step,timeout);
      if(k==='eval')return async(expr:string)=>JSON.parse(JSON.stringify(await o.eval(map(expr))).replaceAll(origin,'https://www.zhipin.com'));
      const value=Reflect.get(o,k,o);return typeof value==='function'?value.bind(o):value;
    }});
    const site=createBossSite(mapped);
    try {
      await browser.open(origin);
      assert.equal((await site.status()).page, expected);
      const opened=await site.open();
      assert.equal(opened.page,expected);
      assert.equal(new URL(opened.url!).pathname,expected==='loggedOut'?'/web/user/':'/');
      if(expected==='loggedOut')await assert.rejects(site.search({keyword:'前端',city:'深圳',page:1}),e=>e instanceof SiteBlockedError&&e.state.page==='loggedOut');
    } finally { await site.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve())); }
  });
}
