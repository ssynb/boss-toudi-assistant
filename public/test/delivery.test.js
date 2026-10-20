import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {runAgentBrowser} from '../../src/browser.ts';
import {resolveCloak,profileArgs} from '../../src/cloak.ts';

test('自动投递无额外批准、手动单请求确认及暂停与未知结果', {timeout:90000}, async()=>{
 const runtime=await resolveCloak();
 const state={doctor:[],codex:{signedIn:true,email:'测试服务器',pendingLoginUrl:null,error:null},browser:{page:'closed'},requirements:'杭州前端',resume:{file:null,text:'合成简历',textSource:'file'},discovery:{status:'idle',message:null,questions:[],startedAt:'2026-01-01T00:00:00Z',finishedAt:'2026-01-01T00:02:05Z'},batch:null,contactedCount:0};
 const streams=new Set();const writes=[];
 const changed=()=>{for(const stream of streams)stream.write('event: changed\n\n');};
 const server=http.createServer(async(req,res)=>{
  if(!req.url.startsWith('/api/')){
   const name=req.url==='/'?'index.html':req.url.slice(1);
   if(!['index.html','app.js','client.js','style.css'].includes(name)){res.writeHead(404).end();return;}
   res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');
   res.end(await fs.readFile(new URL('../'+name,import.meta.url)));return;
  }
  assert.equal(req.headers['x-boss-local'],'1');
  if(req.url==='/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': test\n\n');streams.add(res);res.on('close',()=>streams.delete(res));return;}
  if(req.method!=='GET'){
   let raw='';for await(const chunk of req)raw+=chunk;
   writes.push([req.method,req.url,(raw?JSON.parse(raw):null)]);
   if(req.url==='/api/inputs'){
    const input=JSON.parse(raw);
    if(input.resume.file){res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:{message:'合成文件校验失败'}}));return;}
    state.requirements=input.requirements;state.discovery.questions=[];
   }
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
  await browser('open',`http://127.0.0.1:${server.address().port}`);
  state.batch={version:7,status:'draft',stopReason:null,targets:[{id:'a',title:'前端',company:'合成公司',salary:'25K',reason:'匹配',greeting:'您好',steps:{contact:'todo',greeting:'todo'}}]};changed();
  await browser('wait','--text','前端');
  assert.equal(await inspect("[...document.querySelectorAll('button')].some(b=>!b.hidden&&b.textContent==='确认投递')"),true,'手动模式只需一次确认投递');
  await browser('find','role','button','click','--name','确认投递','--exact');
  await browser('dialog','accept');
  await browser('wait','--text','正在执行');
  assert.deepEqual(writes,[['POST','/api/batch/start',{version:7}]]);
  await browser('find','role','button','click','--name','暂停执行','--exact');
  await browser('wait','--text','用户暂停');
  assert.equal(writes.at(-1)[1],'/api/batch/pause');
  state.batch.targets[0].steps={contact:'unknown',greeting:'unknown'};state.batch.stopReason='合成错误：结果未确认';changed();
  await browser('wait','--text','合成错误');
  assert.match(await browser('get','text','#targets'),/不自动重试/);
  assert.equal(writes.length,2,'暂停和 unknown 不触发自动恢复');
  state.batch=null;changed();
  await browser('wait','--fn',"document.querySelector('#batch').hidden");
  await browser('check','#auto-send');
  await browser('find','role','button','click','--name','开始发现','--exact');
  await browser('wait','--text','停止发现');
  assert.deepEqual(writes.at(-1),['POST','/api/discovery/start',{autoSend:true}]);
  state.batch={version:8,status:'running',stopReason:null,targets:[{id:'b',title:'自动岗位',company:'合成公司',salary:'25K',reason:'匹配',greeting:'您好',steps:{contact:'todo',greeting:'todo'}}]};changed();
  await browser('wait','--text','自动岗位');
  assert.equal(await inspect("[...document.querySelectorAll('button')].filter(b=>b.offsetParent&&/批准|确认投递|继续执行|开始.*执行/.test(b.textContent)).length"),0);
  await browser('find','role','button','click','--name','停止发现','--exact');
  await browser('wait','--text','正在停止');
  assert.equal(writes.at(-1)[1],'/api/discovery/stop');
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
