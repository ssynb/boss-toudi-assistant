/** 环境检查：Node 版本、Codex 与 agent-browser 是否可运行、浏览器是否就绪、数据目录可写。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { DoctorCheck } from './contracts.ts';
import { CODEX_BIN } from './codex.ts';
import { runAgentBrowser } from './browser.ts';
import { resolveCloak } from './cloak.ts';

export const MIN_NODE = [24, 11, 0] as const;

function nodeCheck(): DoctorCheck {
  const v = process.versions.node.split('.').map(Number);
  const ok = v[0]! > MIN_NODE[0] || (v[0] === MIN_NODE[0] && (v[1]! > MIN_NODE[1] || (v[1] === MIN_NODE[1] && v[2]! >= MIN_NODE[2])));
  return { id: 'node', ok, detail: ok ? `Node ${process.versions.node}` : `需要 Node ${MIN_NODE.join('.')} 或更高，当前 ${process.versions.node}` };
}

function codexVersion(): Promise<DoctorCheck> {
  return new Promise((resolve) => {
    const child = spawn(CODEX_BIN, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d));
    child.on('error', (e) => resolve({ id: 'codex', ok: false, detail: `无法运行 Codex：${e.message}` }));
    child.on('close', (code) => resolve({ id: 'codex', ok: code === 0, detail: code === 0 ? out.trim() : `Codex 退出码 ${code}，请重新 npm ci` }));
  });
}

async function browserChecks(): Promise<DoctorCheck[]> {
  const result = await runAgentBrowser(['--version']).catch((e: Error) => ({ code: -1, stdout: '', stderr: e.message }));
  const agent: DoctorCheck = { id: 'agentBrowser', ok: result.code === 0, detail: (result.code === 0 ? result.stdout : result.stderr).trim() };
  try {
    const runtime = await resolveCloak();
    return [agent, { id: 'browser', ok: true, detail: `CloakBrowser 免费旧版 ${runtime.version}（非 latest）：${runtime.binaryPath}` }];
  } catch (e) {
    return [agent, { id: 'browser', ok: false, detail: (e as Error).message }];
  }
}

function dataDirCheck(dataDir: string): DoctorCheck {
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const probe = path.join(dataDir, '.write-test');
    fs.writeFileSync(probe, '');
    fs.rmSync(probe);
    return { id: 'dataDir', ok: true, detail: dataDir };
  } catch (e) {
    return { id: 'dataDir', ok: false, detail: `数据目录不可写：${dataDir}（${(e as Error).message}）` };
  }
}

export async function runDoctor(dataDir: string): Promise<DoctorCheck[]> {
  const [codex, browser] = await Promise.all([codexVersion(), browserChecks()]);
  return [nodeCheck(), codex, ...browser, dataDirCheck(dataDir)];
}
