import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);

test('单一要求保存、原位澄清、异步保留编辑和执行锁定', {timeout:90000}, async()=>{
 const state={doctor:[],codex:{signedIn:true,email:'测试服务器',pendingLoginUrl:null,error:null},browser:{page:'closed'},requirements:'',resume:{file:null,text:'合成简历',textConfirmed:true},discovery:{status:'idle',message:null,questions:[]},batch:null,contactedCount:0};
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
   writes.push([req.method,req.url,JSON.parse(raw)]);
   if(req.url==='/api/requirements'){state.requirements=JSON.parse(raw).text;state.discovery.questions=[];}
  }
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(state));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=async(...args)=>(await exec('bbu',['--as','requirements-acceptance',...args],{timeout:15000})).stdout.trim();
 const inspect=async expression=>JSON.parse(await browser('eval',`${expression}`));
 try{
  await browser('open',`http://127.0.0.1:${server.address().port}`);
  assert.equal(await inspect("Boolean(document.querySelector('#requirements textarea'))"),true,'必须提供唯一具体要求输入');
  await browser('find','label','具体要求','fill','杭州前端，至少 25K');
  await browser('find','role','button','click','--name','保存要求');
  await browser('wait','--fn',"document.querySelector('#requirements output').textContent==='已保存'");
  assert.deepEqual(writes,[['PUT','/api/requirements',{text:'杭州前端，至少 25K'}]]);
  await browser('reload');
  assert.equal(await browser('get','value','#requirements textarea'),'杭州前端，至少 25K');
  assert.equal(await inspect("document.querySelector('[data-action=\"discovery/start\"]').disabled"),false,'尚未打开 BOSS 也可提取要求及澄清');
  await browser('find','label','具体要求','fill','杭州前端，至少 25K，排除外包');
  state.discovery.questions=['本批最多找几个岗位？'];changed();
  await browser('wait','--text','本批最多找几个岗位？');
  assert.equal(await browser('get','value','#requirements textarea'),'杭州前端，至少 25K，排除外包');
  assert.equal(await inspect("document.querySelector('[data-action=\"discovery/start\"]').disabled"),true,'未保存编辑不能发起发现');
  state.discovery.status='running';changed();
  await browser('wait','--fn',"document.querySelector('#requirements fieldset').disabled");
  state.discovery.status='idle';changed();
  await browser('wait','--fn',"!document.querySelector('#requirements fieldset').disabled");
  await browser('find','role','button','click','--name','保存要求');
  await browser('wait','--fn',"document.querySelector('#clarification').hidden");
 }finally{
  await browser('close');for(const stream of streams)stream.end();await new Promise(resolve=>server.close(resolve));
 }
});
