// UI 验收夹具：本地假服务托管 public/，用项目 CloakBrowser 打开；不连接真实 BOSS。
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {runAgentBrowser} from '../../src/browser.ts';
import {resolveCloak,profileArgs} from '../../src/cloak.ts';

export const target=(id,company,title,contact,greeting,extra={})=>({id,jobId:id,company,title,salary:'25K',url:'',reason:'匹配',greeting:`${company}招呼原文`,removed:false,steps:{contact,greeting},evidence:'',updatedAt:'',...extra});

export function baseState(){
 return {doctor:[],codex:{signedIn:true,email:'测试服务器',plan:null,pendingLoginUrl:null,error:null},browser:{page:'ready',url:null},
  requirements:'',resume:{file:null,text:'合成简历',textSource:'pasted'},
  discovery:{status:'idle',autoSend:false,directions:[],message:null,startedAt:null,finishedAt:null},batch:null,contactedCount:0,contactedToday:0,
  supportedCities:['深圳'],research:{status:'idle',city:null,startedAt:null,finishedAt:null,message:null,directions:[]},chat:{pending:false,messages:[]}};
}

/** onWrite(method,url,body,res) 返回 true 表示已自行响应。 */
export async function startApp(state,onWrite=()=>false){
 const runtime=await resolveCloak();
 const streams=new Set();const writes=[];
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
   if(onWrite(req.method,req.url,body,res))return;
  }
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(state));
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
 return {
  browser,writes,dir,
  url:`http://127.0.0.1:${server.address().port}/`,
  inspect:async expression=>JSON.parse(await browser('eval',expression)),
  changed:()=>{for(const stream of streams)stream.write('event: changed\n\n');},
  async close(){
   try{await browser('close');}finally{
    for(const stream of streams)stream.end();
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    await fs.rm(dir,{recursive:true,force:true});
    await fs.rm(socket,{recursive:true,force:true});
   }
  },
 };
}
