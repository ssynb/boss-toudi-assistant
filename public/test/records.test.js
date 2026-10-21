import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startApp,baseState,target} from './harness.js';

test('投递记录：状态如实、招呼只在未确认/失败可展开、暂停时带版本继续且不自动重试', {timeout:90000}, async()=>{
 const state=baseState();
 state.batch={id:'b',version:7,status:'paused',stopReason:'结果未确认，已暂停',createdAt:'',targets:[
  target('a','甲公司','Agent 开发','done','done'),
  target('b','乙公司','AI 应用','done','skipped'),
  target('c','丙公司','前端','skipped','skipped'),
  target('d','丁公司','大模型应用','unknown','skipped'),
  target('e','戊公司','平台前端','failed','skipped'),
  target('f','己公司','已移除','todo','todo',{removed:true}),
  target('g','庚公司','待投','todo','todo')]};
 const app=await startApp(state,(method,url)=>{if(url==='/api/batch/start')state.batch.status='running';return false;});
 const {browser,writes}=app;
 try{
  await browser('open',app.url);
  await browser('find','role','link','click','--name','投递记录','--exact');
  await browser('wait','--text','甲公司 · Agent 开发');
  const rows=await app.inspect("[...document.querySelectorAll('#records li')].map(li=>li.querySelector('.row-title').textContent+'|'+li.querySelector('.state').textContent)");
  assert.deepEqual(rows,['甲公司 · Agent 开发|已送达','乙公司 · AI 应用|已跳过','丙公司 · 前端|已跳过','丁公司 · 大模型应用|未确认','戊公司 · 平台前端|未发生','庚公司 · 待投|待投递']);
  const visible=await app.inspect('document.body.innerText');
  for(const hidden of ['甲公司招呼原文','乙公司招呼原文','丁公司招呼原文','戊公司招呼原文'])assert.ok(!visible.includes(hidden),hidden);
  assert.match(visible,/不自动重试/);
  assert.equal(await app.inspect("document.querySelectorAll('#records li:nth-child(-n+3) summary').length"),0,'已送达/已跳过行不提供招呼展开');
  await browser('find','text','查看招呼语','click');
  assert.match(await app.inspect('document.body.innerText'),/丁公司招呼原文/);
  assert.deepEqual(writes,[],'展示与展开不触发任何请求');
  await browser('find','role','button','click','--name','继续投递','--exact');
  await browser('dialog','accept');
  await browser('wait','--fn',"![...document.querySelectorAll('button')].some(b=>b.textContent==='继续投递'&&!b.hidden)");
  assert.deepEqual(writes,[['POST','/api/batch/start',{version:7}]]);
 }finally{await app.close();}
});
