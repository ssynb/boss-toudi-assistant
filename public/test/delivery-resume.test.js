import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {runAgentBrowser} from '../../src/browser.ts';
import {resolveCloak,profileArgs} from '../../src/cloak.ts';

test('刷新授权边界与手动批次版本', {timeout:90000}, async t=>{
 const runtime=await resolveCloak();
 const state={doctor:[],codex:{signedIn:true,email:'测试服务器',pendingLoginUrl:null,error:null},browser:{page:'closed'},requirements:'杭州前端',resume:{file:null,text:'合成简历',textSource:'file'},discovery:{status:'idle',message:null,questions:[],startedAt:'2026-01-01T00:00:00Z',finishedAt:'2026-01-01T00:02:05Z'},batch:null,contactedCount:0,supportedCities:[],research:{status:'idle',city:null,startedAt:null,finishedAt:null,message:null,directions:[]},chat:{pending:false,messages:[]}};
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
   writes.push([req.method,req.url,(raw?JSON.parse(raw):null)]);
   if(req.url==='/api/discovery/start'){state.discovery.status='running';state.discovery.autoSend=JSON.parse(raw).autoSend;}
   if(req.url==='/api/discovery/stop')state.discovery.status='stopping';
   if(req.url==='/api/batch/start'){state.batch.status='running';}
   if(req.url==='/api/batch/pause'){state.batch.status='paused';state.batch.stopReason='用户暂停';}
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
  const target={id:'a',title:'合成岗位',company:'合成公司',salary:'25K',reason:'匹配',greeting:'您好',steps:{contact:'todo',greeting:'todo'}};
  await t.test('历史自动暂停批次不显示手动确认，也不授权下一轮自动投递',async()=>{
   state.discovery.autoSend=true;
   state.batch={version:9,status:'paused',stopReason:'用户暂停',targets:[target]};
   await browser('open',`http://127.0.0.1:${server.address().port}`);
   await browser('wait','--text','用户暂停');
   assert.equal(await inspect("document.querySelector('#send').hidden"),true);
   assert.equal(await inspect("document.querySelector('#auto-send').checked"),false,'历史自动模式不得成为新一轮授权');
   await browser('find','role','button','click','--name','开始发现','--exact');
   await browser('wait','--text','停止发现');
   assert.deepEqual(writes.at(-1),['POST','/api/discovery/start',{autoSend:false}]);
  });
  await t.test('已批准和暂停批次都确认用户看到的版本',async()=>{
   state.discovery.autoSend=false;state.discovery.status='idle';
   const confirmations=[];
   for(const [status,version] of [['approved',10],['paused',11]]){
    state.batch={version,status,stopReason:null,targets:[target]};
    await browser('reload');
    await browser('wait','--text','合成岗位');
    await browser('find','role','button','click','--name',status==='paused'?'继续投递':'确认投递','--exact');
    await browser('dialog','accept');
    await browser('wait','--text','正在执行');
    confirmations.push(writes.at(-1));
   }
   assert.deepEqual(confirmations,[['POST','/api/batch/start',{version:10}],['POST','/api/batch/start',{version:11}]]);
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
