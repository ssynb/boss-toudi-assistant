import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startApp,baseState} from './harness.js';

test('固定招呼语随资料保存，对话页提示未设置招呼语与今日浏览额度', {timeout:120000}, async t=>{
 const state=baseState();
 state.jobReadsToday=120;
 const app=await startApp(state,(method,url,body)=>{if(url==='/api/inputs')state.greeting=body.greeting.trim();return false;});
 const {browser,writes}=app;
 const body=()=>app.inspect('document.body.innerText');
 try{
  await browser('open',app.url);
  await t.test('未设置招呼语时空对话提示先去个人信息页，并显示今日已浏览',async()=>{
   await browser('wait','--text','今日已浏览 120/250');
   assert.match(await body(),/固定招呼语/);
   await browser('find','role','link','click','--name','去设置','--exact');
   await browser('wait','--fn',"location.hash==='#profile'");
  });
  await t.test('个人信息页填写招呼语显示字数，与简历一起保存',async()=>{
   await browser('find','label','固定招呼语','fill','您好，我有五年前端经验');
   assert.match(await body(),/11\/120/);
   assert.equal(await app.inspect("document.querySelector('textarea[name=greeting]').maxLength"),120,'输入上限来自状态');
   await browser('find','role','button','click','--name','保存','--exact');
   await browser('wait','--text','已保存');
   assert.deepEqual(writes,[['PUT','/api/inputs',{requirements:'',greeting:'您好，我有五年前端经验',resume:{text:null}}]]);
  });
  await t.test('设置后不再提示；接近上限提示明天继续，进度条同样显示浏览额度',async()=>{
   await browser('find','role','link','click','--name','对话','--exact');
   await browser('wait','--text','今日已浏览 120/250');
   assert.doesNotMatch(await body(),/去设置/);
   assert.doesNotMatch(await body(),/明天/);
   state.jobReadsToday=240;app.changed();
   await browser('wait','--text','今日已浏览 240/250');
   assert.match(await body(),/明天/);
   state.discovery={...state.discovery,status:'running',directions:[{name:'Agent 开发',count:30,selected:3}]};
   state.jobReadsToday=250;app.changed();
   await browser('wait','--text','今日已浏览 250/250');
   const strip=await browser('get','text','[aria-label=任务进度]');
   assert.match(strip,/今日已浏览 250\/250/);
   assert.match(await body(),/明天/);
  });
 }finally{await app.close();}
});
