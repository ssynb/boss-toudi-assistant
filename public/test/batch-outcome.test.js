import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {runAgentBrowser} from '../../src/browser.ts';
import {resolveCloak,profileArgs} from '../../src/cloak.ts';

const target=(id,contact,greeting)=>({id,jobId:id,company:'合成公司',title:`岗位${id}`,salary:'25K',url:'',reason:'匹配',greeting:'您好',removed:false,steps:{contact,greeting},evidence:'',updatedAt:''});

test('只有招呼实际发出才计为已送达，跳过不算送达', {timeout:90000}, async()=>{
 const runtime=await resolveCloak();
 const state={doctor:[],codex:{signedIn:true,email:null,pendingLoginUrl:null,error:null},browser:{page:'ready',url:null},requirements:'杭州前端',resume:{file:null,text:'合成简历',textSource:'pasted'},
  discovery:{status:'idle',autoSend:false,message:null,questions:[],startedAt:null,finishedAt:null},contactedCount:0,
  supportedCities:[],research:{status:'idle',city:null,startedAt:null,finishedAt:null,message:null,directions:[]},chat:{pending:false,messages:[]},
  // 历史已联系/未确认被去重跳过、已有本方消息未再发送、本次真实发出招呼
  batch:{id:'b',version:3,status:'done',stopReason:null,createdAt:'',targets:[target('a','skipped','skipped'),target('b','done','skipped'),target('c','done','done')]}};
 const server=http.createServer(async(req,res)=>{
  if(req.url==='/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': test\n\n');return;}
  if(req.url.startsWith('/api/')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(state));return;}
  const name=req.url==='/'?'index.html':req.url.slice(1);
  if(!/^[a-z-]+\.(js|css|html)$/.test(name)){res.writeHead(404).end();return;}
  try{const body=await fs.readFile(new URL('../'+name,import.meta.url));res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(body);}catch{res.writeHead(404).end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'boss-ui-'));
 const profile=path.join(dir,'profile');
 const flags=profileArgs(runtime,profile);
 const socket=await fs.mkdtemp(path.join(process.platform==='win32'?os.tmpdir():'/tmp','boss-ui-socket-'));
 const browser=async(...args)=>{
  const result=await runAgentBrowser(['--session','ui','--profile',profile,'--headed','false','--executable-path',runtime.binaryPath,'--args',flags.join(','),...args],
   {env:{HOME:dir,USERPROFILE:dir,AGENT_BROWSER_SOCKET_DIR:socket,AGENT_BROWSER_NAMESPACE:'ui-test'}});
  assert.equal(result.code,0,result.stderr||result.stdout);
  return result.stdout.trim();
 };
 try{
  await browser('open',`http://127.0.0.1:${server.address().port}`);
  await browser('wait','--text','岗位c');
  const summary=await browser('get','text','#batch-state');
  assert.match(summary,/已送达 1(?!\d)/,summary);
  assert.match(summary,/已跳过 2(?!\d)/,summary);
 }finally{
  try{await browser('close');}finally{
   server.closeAllConnections();
   await new Promise(resolve=>server.close(resolve));
   await fs.rm(dir,{recursive:true,force:true});
   await fs.rm(socket,{recursive:true,force:true});
  }
 }
});
