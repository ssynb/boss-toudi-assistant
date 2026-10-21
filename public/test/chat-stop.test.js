import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startApp,baseState} from './harness.js';

test('等待 AI 决定期间也能停止，且只发停止请求', {timeout:90000}, async()=>{
 const state=baseState();
 state.chat={pending:true,messages:[{role:'user',text:'Agent开发投30个',at:'2026-01-01T00:00:00Z'}]};
 const app=await startApp(state,(method,url)=>{if(url==='/api/discovery/stop')state.chat.pending=false;return false;});
 const {browser,writes}=app;
 try{
  await browser('open',app.url);
  await browser('wait','--text','正在思考');
  await browser('find','role','button','click','--name','停止','--exact');
  await browser('wait','--fn',"document.querySelector('[aria-label=任务进度]').hidden");
  assert.deepEqual(writes,[['POST','/api/discovery/stop',null]]);
 }finally{await app.close();}
});
