import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {runAgentBrowser} from '../../src/browser.ts';
import {resolveCloak,profileArgs} from '../../src/cloak.ts';

const long='实际 JD 普遍要求跨团队推动与数据分析能力，'.repeat(12)+'理由结尾';

test('长方向理由默认折叠可展开，顾问回复加粗与换行按纯文本渲染', {timeout:90000}, async()=>{
 const runtime=await resolveCloak();
 const state={doctor:[],codex:{signedIn:true,email:null,pendingLoginUrl:null,error:null},browser:{page:'ready',url:null},requirements:'杭州前端',resume:{file:null,text:'合成简历',textSource:'pasted'},
  discovery:{status:'idle',autoSend:false,message:null,questions:[],startedAt:null,finishedAt:null},contactedCount:0,
  supportedCities:['深圳'],batch:null,
  research:{status:'idle',city:'深圳',startedAt:null,finishedAt:null,message:null,directions:[{name:'产品运营',keywords:['产品运营'],fit:'high',reason:long,gaps:'缺少行业经验，'.repeat(10),salaryRange:'15-25K',sampled:10,matched:7}]},
  chat:{pending:false,messages:[{role:'assistant',text:'建议：\n**先投产品运营**<img src=x onerror=alert(1)>\n再补数据分析',at:'2026-01-01T00:00:00Z'}]}};
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
  await browser('wait','--text','产品运营');
  const toggle="[...document.querySelectorAll('#directions button')].find(b=>b.getAttribute('aria-expanded'))";
  assert.equal(await browser('eval',`${toggle}?.textContent`),'"展开"');
  assert.equal(await browser('eval',`${toggle}.getAttribute('aria-expanded')`),'"false"');
  await browser('find','role','button','click','--name','展开','--exact');
  assert.equal(await browser('eval',`${toggle}.getAttribute('aria-expanded')`),'"true"');
  assert.match(await browser('get','text','#directions'),/理由结尾/);
  await browser('find','role','button','click','--name','收起','--exact');
  assert.equal(await browser('eval',`${toggle}.getAttribute('aria-expanded')`),'"false"');
  const reply=await browser('eval',"(()=>{const p=document.querySelector('.message.assistant p');return {text:p.innerText,strong:[...p.querySelectorAll('strong')].map(s=>s.textContent),img:p.querySelectorAll('img').length};})()");
  const parsed=JSON.parse(reply);
  assert.deepEqual(parsed.strong,['先投产品运营']);
  assert.equal(parsed.img,0,'不插入 HTML');
  assert.doesNotMatch(parsed.text,/\*\*/);
  assert.match(parsed.text,/建议：\n先投产品运营<img src=x onerror=alert\(1\)>\n再补数据分析/);
 }finally{
  try{await browser('close');}finally{
   server.closeAllConnections();
   await new Promise(resolve=>server.close(resolve));
   await fs.rm(dir,{recursive:true,force:true});
   await fs.rm(socket,{recursive:true,force:true});
  }
 }
});
