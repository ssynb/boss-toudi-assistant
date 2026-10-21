import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {runAgentBrowser} from '../../src/browser.ts';
import {resolveCloak,profileArgs} from '../../src/cloak.ts';

const direction=(name,fit,matched)=>({name,keywords:[name],fit,reason:`${name}合成理由`,gaps:`${name}合成短板`,salaryRange:'20-40K',sampled:10,matched});

test('发现方式、方向调研与求职顾问', {timeout:120000}, async t=>{
 const runtime=await resolveCloak();
 const state={doctor:[],codex:{signedIn:true,email:'测试服务器',pendingLoginUrl:null,error:null},browser:{page:'ready',url:null},requirements:'杭州前端',resume:{file:null,text:'合成简历',textSource:'pasted'},
  discovery:{status:'idle',autoSend:false,message:null,questions:[],startedAt:null,finishedAt:null},batch:null,contactedCount:0,
  supportedCities:['北京','杭州'],research:{status:'idle',city:null,startedAt:null,finishedAt:null,message:null,directions:[]},chat:{pending:false,messages:[]}};
 const streams=new Set();const writes=[];
 const changed=()=>{for(const stream of streams)stream.write('event: changed\n\n');};
 const server=http.createServer(async(req,res)=>{
  if(!req.url.startsWith('/api/')){
   const name=req.url==='/'?'index.html':req.url.slice(1);
   if(!/^[a-z-]+\.(js|css|html)$/.test(name)){res.writeHead(404).end();return;}
   try{const body=await fs.readFile(new URL('../'+name,import.meta.url));res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(body);}catch{res.writeHead(404).end();}
   return;
  }
  assert.equal(req.headers['x-boss-local'],'1');
  if(req.url==='/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': test\n\n');streams.add(res);res.on('close',()=>streams.delete(res));return;}
  if(req.method!=='GET'){
   let raw='';for await(const chunk of req)raw+=chunk;
   const body=raw?JSON.parse(raw):null;
   writes.push([req.method,req.url,body]);
   if(req.url==='/api/discovery/start')state.discovery={...state.discovery,status:'running',autoSend:body.autoSend};
   if(req.url==='/api/research/start')state.research={...state.research,status:'running',city:body.city,directions:[]};
   if(req.url==='/api/research/stop')state.research.status='stopping';
   if(req.url==='/api/chat'){state.chat={pending:true,messages:[...state.chat.messages,{role:'user',text:body.message,at:new Date().toISOString()}]};}
   if(req.url==='/api/chat/clear')state.chat={pending:false,messages:[]};
  }
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(state));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'boss-ui-'));
 const profile=path.join(dir,'profile');
 const flags=profileArgs(runtime,profile);
 const socket=await fs.mkdtemp(path.join(process.platform==='win32'?os.tmpdir():'/tmp','boss-ui-socket-'));
 const browser=async(...args)=>{
  const result=await runAgentBrowser(['--session','ui','--profile',profile,'--headed','false',
   '--executable-path',runtime.binaryPath,'--args',flags.join(','),...args],
   {env:{HOME:dir,USERPROFILE:dir,AGENT_BROWSER_SOCKET_DIR:socket,AGENT_BROWSER_NAMESPACE:'ui-test'}});
  assert.equal(result.code,0,result.stderr||result.stdout);
  return result.stdout.trim();
 };
 const inspect=async expression=>JSON.parse(await browser('eval',`${expression}`));
 try{
  await browser('open',`http://127.0.0.1:${server.address().port}`);
  await browser('wait','--text','测试服务器');

  await t.test('两个发现方式互斥，「只找岗位，稍后投递」不自动投递',async()=>{
   await browser('find','role','radio','check','--name','找到就投','--exact');
   await browser('find','role','radio','check','--name','只找岗位，稍后投递','--exact');
   await browser('find','role','button','click','--name','开始发现','--exact');
   await browser('wait','--text','停止发现');
   assert.deepEqual(writes.at(-1),['POST','/api/discovery/start',{autoSend:false}]);
   state.discovery.status='idle';changed();
   await browser('wait','--text','开始发现');
  });

  await t.test('选城市调研，可停止，勾选方向只填入本地草稿',async()=>{
   await browser('select','select[name=city]','杭州');
   await browser('find','role','button','click','--name','开始调研','--exact');
   await browser('wait','--text','停止调研');
   assert.deepEqual(writes.at(-1),['POST','/api/research/start',{city:'杭州'}]);
   await browser('find','role','button','click','--name','停止调研','--exact');
   await browser('wait','--fn',"[...document.querySelectorAll('button')].some(b=>b.textContent==='正在停止…'&&b.disabled)");
   assert.equal(writes.at(-1)[1],'/api/research/stop');
   state.research={...state.research,status:'idle',directions:[direction('中后台前端','high',8),direction('可视化前端','medium',4),direction('AI 应用前端','low',1)]};changed();
   await browser('wait','--text','中后台前端合成短板');
   const panel=await browser('get','text','body');
   for(const fact of ['中后台前端合成理由','20-40K','抽样 10','匹配 8'])assert.ok(panel.includes(fact),fact);
   const before=writes.length;
   await browser('find','role','checkbox','check','--name','中后台前端','--exact');
   await browser('find','role','checkbox','check','--name','可视化前端','--exact');
   await browser('find','role','button','click','--name','填入具体要求','--exact');
   const draft=await browser('get','value','[name=requirements]');
   assert.match(draft,/^杭州前端/);
   assert.match(draft,/中后台前端/);assert.match(draft,/可视化前端/);assert.doesNotMatch(draft,/AI 应用前端/);
   assert.equal(writes.length,before,'填入只改本地草稿');
   assert.equal(await browser('get','text','#inputs output'),'有未保存修改');
  });

  await t.test('顾问对话：只给建议提示、发送中禁用、回复展示、清空',async()=>{
   assert.match(await browser('get','text','body'),/只给建议.*不会投递|不会投递.*只给建议/);
   await browser('find','label','问顾问','fill','先投哪个方向？');
   await browser('find','role','button','click','--name','发送','--exact');
   await browser('wait','--text','顾问正在回复');
   assert.deepEqual(writes.at(-1),['POST','/api/chat',{message:'先投哪个方向？'}]);
   assert.equal(await inspect("[...document.querySelectorAll('button')].find(b=>b.textContent==='发送').disabled"),true);
   state.chat={pending:false,messages:[...state.chat.messages,{role:'assistant',text:'建议先投中后台方向',at:new Date().toISOString()}]};changed();
   await browser('wait','--text','建议先投中后台方向');
   assert.match(await browser('get','text','body'),/先投哪个方向？/);
   await browser('find','role','button','click','--name','清空对话','--exact');
   await browser('wait','--fn',"!document.body.textContent.includes('建议先投中后台方向')");
   assert.equal(writes.at(-1)[1],'/api/chat/clear');
  });
 }finally{
  try{await browser('close');}finally{
   for(const stream of streams)stream.end();
   server.closeAllConnections();
   await new Promise(resolve=>server.close(resolve));
   await fs.rm(dir,{recursive:true,force:true});
   await fs.rm(socket,{recursive:true,force:true});
  }
 }
});
