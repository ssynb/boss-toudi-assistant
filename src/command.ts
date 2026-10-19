import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 后台进程可能继承输出句柄；文件承接输出，以直接子进程退出为完成条件，不等管道 EOF。 */
export async function runCommand(
  command: string, args: string[], env: NodeJS.ProcessEnv, timeout: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-command-'));
  const output = path.join(dir, 'stdout');
  const errors = path.join(dir, 'stderr');
  const descriptors: number[] = [];
  try {
    descriptors.push(fs.openSync(output, 'w', 0o600));
    descriptors.push(fs.openSync(errors, 'w', 0o600));
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(command, args, { env, stdio: ['ignore', descriptors[0]!, descriptors[1]!], windowsHide: true });
      let expired = false;
      const timer = setTimeout(() => { expired = true; child.kill(); }, timeout);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => {
        clearTimeout(timer);
        if (expired) reject(new Error(`命令超过 ${timeout} ms，已停止`));
        else resolve(code ?? -1);
      });
    });
    return { code, stdout: fs.readFileSync(output, 'utf8'), stderr: fs.readFileSync(errors, 'utf8') };
  } finally {
    for (const descriptor of descriptors) fs.closeSync(descriptor);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
