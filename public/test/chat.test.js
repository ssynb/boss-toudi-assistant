import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startApp,baseState,target} from './harness.js';

test('对话：示例提问、发送与等待、安全富文本、任务进度与停止', {timeout:120000}, async t=>{
 const state=baseState();
 state.contactedToday=42;
 const app=await startApp(state,(method,url,body)=>{
  if(url==='/api/chat')state.chat={pending:true,messages:[...state.chat.messages,{role:'user',text:body.message,at:new Date().toISOString()}]};
  if(url==='/api/discovery/stop')state.discovery.status='stopping';
  if(url==='/api/research/stop')state.research.status='stopping';
  if(url==='/api/batch/pause')state.batch.status='paused';
  return false;
 });
 const {browser,writes}=app;
 try{
  await browser('open',app.url);
  await t.test('空对话给出示例提问，点击只填入输入框不发送',async()=>{
   await browser('find','role','button','click','--name','Agent开发投30个，AI应用投20个','--exact');
   assert.equal(await browser('get','value','textarea[name=message]'),'Agent开发投30个，AI应用投20个');
   assert.deepEqual(writes,[]);
  });
  await t.test('发送后等待回复期间不能再发，回复的加粗与换行按纯文本渲染',async()=>{
   await browser('find','role','button','click','--name','发送','--exact');
   await browser('wait','--text','正在思考');
   assert.deepEqual(writes.at(-1),['POST','/api/chat',{message:'Agent开发投30个，AI应用投20个'}]);
   assert.equal(await app.inspect("document.querySelector('textarea[name=message]').value"),'');
   await browser('find','label','发消息','fill','再问一句');
   assert.equal(await app.inspect("[...document.querySelectorAll('button')].find(b=>b.textContent==='发送').disabled"),true);
   state.chat={pending:false,messages:[...state.chat.messages,{role:'assistant',text:'调研结果：\n**Agent 开发** 匹配度高<img src=x onerror=alert(1)>\n下一步',at:new Date().toISOString()}]};app.changed();
   await browser('wait','--text','下一步');
   const reply=await app.inspect("(()=>{const m=[...document.querySelectorAll('[data-role=assistant]')].at(-1);return {text:m.innerText,strong:[...m.querySelectorAll('strong')].map(s=>s.textContent),img:m.querySelectorAll('img').length};})()");
   assert.deepEqual(reply.strong,['Agent 开发']);
   assert.equal(reply.img,0);
   assert.match(reply.text,/调研结果：\nAgent 开发 匹配度高<img src=x onerror=alert\(1\)>\n下一步/);
  });
  const scenarios=[
   ['发现',()=>{state.discovery={...state.discovery,status:'running',directions:[{name:'Agent 开发',count:30,selected:12},{name:'AI 应用',count:20,selected:5}]};},['Agent 开发 12/30','AI 应用 5/20'],'/api/discovery/stop',()=>{state.discovery.status='idle';}],
   ['调研',()=>{state.research={...state.research,status:'running',city:'深圳'};},['调研'],'/api/research/stop',()=>{state.research.status='idle';}],
   ['投递',()=>{state.batch={id:'b',version:5,status:'running',stopReason:null,createdAt:'',targets:[target('a','甲','前端','done','done'),target('b','乙','前端','done','skipped'),target('c','丙','前端','todo','todo')]};},['已送达 1'],'/api/batch/pause',()=>{}],
  ];
  for(const [name,start,facts,stop,finish] of scenarios){
   await t.test(`${name}进行中：输入区上方显示进度与今日额度，「停止」只发对应停止请求`,async()=>{
    start();app.changed();
    await browser('wait','--text','今日已联系 42/80');
    const strip=await browser('get','text','[role=status][aria-label=任务进度]');
    for(const fact of facts)assert.ok(strip.includes(fact),`${fact} ∉ ${strip}`);
    assert.equal(await app.inspect("[...document.querySelectorAll('button')].find(b=>b.textContent==='发送').disabled"),true,'任务进行中不能发消息');
    const before=writes.length;
    await browser('find','role','button','click','--name','停止','--exact');
    await browser('wait','--fn',"!document.querySelector('[aria-label=任务进度]')||document.querySelector('[aria-label=任务进度]').hidden||[...document.querySelectorAll('button')].some(b=>b.textContent==='正在停止…'&&b.disabled)");
    assert.deepEqual(writes.slice(before).map(w=>w[1]),[stop]);
    finish();app.changed();
   });
  }
 }finally{await app.close();}
});
