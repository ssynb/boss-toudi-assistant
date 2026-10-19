import { spawn } from 'node:child_process';

export function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv, timeout: number): Promise<{code:number;stdout:string;stderr:string}> {
 return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  let stdout='',stderr='';
  child.stdout.on('data',d=>{stdout+=d;});
  child.stderr.on('data',d=>{stderr+=d;});
  const timer=setTimeout(()=>child.kill(),timeout);
  child.on('error',reject);
  child.on('close',code=>{clearTimeout(timer);resolve({code:code??-1,stdout,stderr});});
 });
}
