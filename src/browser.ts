import { systemEnvironment } from './process-env.ts';
/**
 * agent-browser CLI 的薄封装：独立 session、独立持久 profile、独立 daemon 命名空间，
 * 不接管用户日常浏览器。命令串行执行；直接 spawn node + 包内启动脚本，不经过 shell。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { resolveCloak, profileArgs, defaultCloakCache } from './cloak.ts';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const AGENT_BROWSER_BIN = path.join(path.dirname(require.resolve('agent-browser/package.json')), 'bin', 'agent-browser.js');

const SESSION = 'boss';
const CONFIG = fileURLToPath(new URL('./browser-config.json', import.meta.url));
const COMMAND_TIMEOUT_MS = 90_000;

export interface BrowserOptions {
  profileDir: string;
  headed: boolean;
  /** agent-browser 守护进程命名空间，避免与用户自己的 agent-browser 会话互相影响。 */
  namespace: string;
}

export interface Snapshot {
  refs: Record<string, { role: string; name: string }>;
  snapshot: string;
}

/** 直接运行 agent-browser（不带本应用的 session 参数），供遥控与版本检查使用（不安装普通 Chrome）。 */
export function runAgentBrowser(args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [AGENT_BROWSER_BIN, '--config', CONFIG, ...args], {
      env: { ...systemEnvironment(), ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d));
    child.stderr?.on('data', (d: Buffer) => (stderr += d));
    const timer = setTimeout(() => child.kill(), COMMAND_TIMEOUT_MS);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export class Browser {
  readonly #opts: BrowserOptions;
  #queue: Promise<unknown> = Promise.resolve();
  #open = false;
  #runtime: { binaryPath: string; args: string[] } | null = null;

  constructor(opts: BrowserOptions) {
    this.#opts = opts;
  }

  get isOpen(): boolean {
    return this.#open;
  }

  async open(url: string): Promise<void> {
    await this.#run(['open', url]);
    this.#open = true;
  }

  /** 求值表达式并按 JSON 返回结果。 */
  async eval<T>(expression: string): Promise<T> {
    const data = (await this.#run(['eval', `JSON.stringify(${expression})`])) as { result: string };
    return JSON.parse(data.result) as T;
  }

  async snapshot(selector?: string): Promise<Snapshot> {
    return (await this.#run(['snapshot', '-i', ...(selector ? ['-s', selector] : [])])) as Snapshot;
  }

  async click(ref: string): Promise<void> {
    await this.#run(['click', `@${ref}`]);
  }

  async fill(ref: string, text: string): Promise<void> {
    await this.#run(['fill', `@${ref}`, text]);
  }

  async press(key: string): Promise<void> {
    await this.#run(['press', key]);
  }

  async waitFor(expression: string): Promise<void> {
    await this.#run(['wait', '--fn', expression]);
  }

  async close(): Promise<void> {
    if (!this.#open) return;
    this.#open = false;
    await this.#run(['close']);
  }

  #run(args: string[]): Promise<unknown> {
    const next = this.#queue.then(() => this.#exec(args));
    this.#queue = next.catch(() => {});
    return next;
  }

  async #exec(args: string[]): Promise<unknown> {
    const cache = defaultCloakCache();
    if (!this.#runtime) {
      const runtime = await resolveCloak(cache);
      this.#runtime = { binaryPath: runtime.binaryPath, args: profileArgs(runtime, this.#opts.profileDir) };
    }
    const home = path.join(path.dirname(this.#opts.profileDir), 'cloak-home');
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    // Unix domain socket 路径长度有限，不能跟随深层 profile/HOME 目录。
    const socketDir = path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', `boss-cb-${createHash('sha256').update(this.#opts.profileDir + this.#opts.namespace).digest('hex').slice(0, 16)}`);
    fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    const global = ['--session', SESSION, '--profile', this.#opts.profileDir, '--headed', String(this.#opts.headed),
      '--executable-path', this.#runtime.binaryPath, '--args', this.#runtime.args.join(',')];
    const { code, stdout, stderr } = await runAgentBrowser([...global, ...args, '--json'], {
      env: { AGENT_BROWSER_NAMESPACE: this.#opts.namespace, AGENT_BROWSER_SOCKET_DIR: socketDir, HOME: home, USERPROFILE: home, CLOAKBROWSER_CACHE_DIR: cache },
    });
    let parsed: { success: boolean; data: unknown; error: string | null };
    try {
      parsed = JSON.parse(stdout.trim().split('\n').at(-1) ?? '');
    } catch {
      throw new Error(`浏览器命令 ${args[0]} 失败（退出码 ${code}）：${(stderr || stdout).trim().slice(0, 300)}`);
    }
    if (code !== 0 || !parsed.success) throw new Error(`浏览器命令 ${args[0]} 失败（退出码 ${code}）：${parsed.error ?? '未知错误'}`);
    return parsed.data;
  }
}
