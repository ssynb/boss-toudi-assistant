import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {runAgentBrowser} from '../../src/browser.ts';
import {resolveCloak,profileArgs} from '../../src/cloak.ts';

test('原子保存草稿、文件失败保留输入、停止与权威计时', {timeout:90000}, async()=>{
 const runtime=await resolveCloak();
 const state={doctor:[],codex:{signedIn:true,email:'测试服务器',pendingLoginUrl:null,error:null},browser:{page:'closed'},requirements:'',resume:{file:null,text:'合成简历',textSource:'file'},discovery:{status:'idle',message:null,questions:[],startedAt:'2026-01-01T00:00:00Z',finishedAt:'2026-01-01T00:02:05Z'},batch:null,contactedCount:0};
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
   if(req.url==='/api/discovery/stop')state.discovery.status='stopping';
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
  assert.equal(await inspect("Boolean(document.querySelector('#inputs textarea[name=requirements]'))"),true,'只有统一输入保存入口');
  await browser('find','label','具体要求','fill','杭州前端，至少 25K');
  await browser('find','role','button','click','--name','保存','--exact');
  await browser('wait','--fn',"document.querySelector('#inputs output').textContent==='已保存'");
  assert.deepEqual(writes,[['PUT','/api/inputs',{requirements:'杭州前端，至少 25K',resume:{text:null}}]]);
  await browser('reload');
  assert.equal(await browser('get','value','[name=requirements]'),'杭州前端，至少 25K');
  assert.equal(await browser('get','text','#elapsed'),'2:05');
  await browser('find','label','具体要求','fill','杭州前端，至少 25K，排除外包');
  state.discovery.questions=['本批最多找几个岗位？'];changed();
  await browser('wait','--text','本批最多找几个岗位？');
  assert.equal(await browser('get','value','[name=requirements]'),'杭州前端，至少 25K，排除外包');
  const file=path.join(dir,'synthetic.pdf');
  await fs.writeFile(file,'%PDF-synthetic');
  try{
   await browser('upload','input[type=file]',file);
   assert.equal(writes.length,1,'选择文件不得上传');
   await browser('find','label','简历正文','fill','PDF 合成正文');
   await browser('find','role','button','click','--name','保存','--exact');
   await browser('wait','--text','合成文件校验失败');
   assert.deepEqual(writes[1],['PUT','/api/inputs',{requirements:'杭州前端，至少 25K，排除外包',resume:{file:{fileName:'synthetic.pdf',base64:Buffer.from('%PDF-synthetic').toString('base64')},text:'PDF 合成正文'}}]);
   assert.equal(await browser('get','value','[name=requirements]'),'杭州前端，至少 25K，排除外包');
   assert.equal(await browser('get','value','[name=resumeText]'),'PDF 合成正文');
   assert.equal(await inspect("document.querySelector('input[type=file]').files[0].name"),'synthetic.pdf');
  }finally{await fs.unlink(file);}
  state.discovery.status='running';state.discovery.startedAt=new Date(Date.now()-65000).toISOString();state.discovery.finishedAt=null;changed();
  await browser('wait','--fn',"document.querySelector('#inputs fieldset').disabled");
  await browser('find','role','button','click','--name','停止发现','--exact');
  await browser('wait','--fn',"document.querySelector('#discover').disabled && document.querySelector('#discover').textContent==='正在停止…'");
  state.discovery.status='idle';state.discovery.startedAt='2026-01-01T00:00:00Z';state.discovery.finishedAt='2026-01-01T00:02:05Z';changed();
  await browser('wait','--fn',"!document.querySelector('#inputs fieldset').disabled");
  assert.equal(await browser('get','text','#elapsed'),'2:05');
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
