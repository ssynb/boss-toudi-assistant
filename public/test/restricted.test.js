import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startApp,baseState} from './harness.js';

test('BOSS 访问受限：顶部如实显示，对话页给出站点原文并提示勿刷新，不提供打开/重试入口', {timeout:90000}, async()=>{
 const state=baseState();
 state.browser={page:'restricted',url:null,message:'您的账号访问受限，将于 2026-10-29 10:00 恢复'};
 const app=await startApp(state);
 const {browser,writes}=app;
 try{
  await browser('open',app.url);
  await browser('wait','--text','BOSS · 访问受限');
  const text=await app.inspect('document.body.innerText');
  assert.match(text,/您的账号访问受限，将于 2026-10-29 10:00 恢复/);
  assert.match(text,/勿刷新/);
  const entries=await app.inspect("[...document.querySelectorAll('button,a')].filter(n=>n.offsetParent&&!n.disabled&&/BOSS|登录|重试/.test(n.textContent)).map(n=>n.textContent)");
  assert.deepEqual(entries,[],'不提供登录或重试入口');
  state.browser={page:'ready',url:null};app.changed();
  await browser('wait','--text','BOSS · 已登录');
  assert.doesNotMatch(await app.inspect('document.body.innerText'),/勿刷新/);
  assert.deepEqual(writes,[]);
 }finally{await app.close();}
});
