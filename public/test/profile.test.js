import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startApp,baseState} from './harness.js';

test('个人信息：手机导航可达，一次保存偏好与简历，文件失败保留输入', {timeout:90000}, async()=>{
 const state=baseState();
 const app=await startApp(state,(method,url,body,res)=>{
  if(url!=='/api/inputs')return false;
  if(body.resume.file){res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:{message:'合成文件校验失败'}}));return true;}
  state.requirements=body.requirements;return false;
 });
 const {browser,writes}=app;
 const file=path.join(app.dir,'synthetic.pdf');
 try{
  await browser('set','viewport','390','844');
  await browser('open',app.url);
  await browser('find','role','link','click','--name','个人信息','--exact');
  await browser('find','label','求职偏好（可选）','fill','深圳，月薪至少 25K');
  await browser('find','role','button','click','--name','保存','--exact');
  await browser('wait','--text','已保存');
  assert.deepEqual(writes,[['PUT','/api/inputs',{requirements:'深圳，月薪至少 25K',greeting:'',resume:{text:null}}]]);
  await fs.writeFile(file,'%PDF-synthetic');
  await browser('upload','input[type=file]',file);
  await browser('find','label','简历正文','fill','PDF 合成正文');
  await browser('find','role','button','click','--name','保存','--exact');
  await browser('wait','--text','合成文件校验失败');
  assert.deepEqual(writes[1],['PUT','/api/inputs',{requirements:'深圳，月薪至少 25K',greeting:'',resume:{file:{fileName:'synthetic.pdf',base64:Buffer.from('%PDF-synthetic').toString('base64')},text:'PDF 合成正文'}}]);
  assert.equal(await browser('get','value','[name=resumeText]'),'PDF 合成正文');
  assert.equal(await app.inspect("document.querySelector('input[type=file]').files[0].name"),'synthetic.pdf');
 }finally{await app.close();}
});
