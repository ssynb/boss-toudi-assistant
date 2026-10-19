import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, events } from '../client.js';
test('本机请求携带保护头，服务器拒绝向调用者显示原始错误', async () => {
 const old = globalThis.fetch;
 globalThis.fetch = async (_, options) => {
  assert.equal(options.headers['X-Boss-Local'], '1');
  return new Response(JSON.stringify({error:{message:'批准已过期'}}), {status:409});
 };
 try { await assert.rejects(request('/api/batch/approve','POST',{version:3}), /批准已过期/); }
 finally { globalThis.fetch = old; }
});
test('事件跨网络分块仍只通知完整事件，并带本机头', async () => {
 const old = globalThis.fetch; const seen=[];
 globalThis.fetch = async (_, options) => {
  assert.equal(options.headers['X-Boss-Local'],'1');
  return new Response(new ReadableStream({start(c){for(const s of ['event: cha','nged\n\nevent: log\ndata: {"text":"正在读取"}\n','\n']) c.enqueue(new TextEncoder().encode(s)); c.close();}}));
 };
 try {await events((name,data)=>seen.push([name,data])); assert.deepEqual(seen,[['changed',null],['log',{text:'正在读取'}]]);}
 finally {globalThis.fetch=old;}
});
