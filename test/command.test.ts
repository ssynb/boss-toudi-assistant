import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCommand } from '../src/command.ts';

test('命令退出即交付完整输出，不等待继承输出句柄的后台进程', async () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boss-command-test-'));
 const pidFile=path.join(dir,'pid');
 const source=`const {spawn}=require('node:child_process');
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2],detached:true});
 require('node:fs').writeFileSync(process.argv[1],String(child.pid));child.unref();
 require('node:fs').writeSync(1,'完成'.repeat(10000));require('node:fs').writeSync(2,'诊断');process.exitCode=7;`;
 let timer: NodeJS.Timeout | undefined;
 try {
  const result=await Promise.race([
   runCommand(process.execPath,['-e',source,pidFile],process.env,5000),
   new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('后台句柄阻塞了已退出命令的结果')),2000);}),
  ]);
  assert.equal(result.code,7);
  assert.equal(result.stdout,'完成'.repeat(10000));
  assert.equal(result.stderr,'诊断');
 } finally {
  clearTimeout(timer);
  if(fs.existsSync(pidFile)) process.kill(Number(fs.readFileSync(pidFile,'utf8')));
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
