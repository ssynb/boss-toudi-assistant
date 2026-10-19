import { systemEnvironment } from './process-env.ts';
/**
 * Codex app-server（stdio JSON-RPC）客户端。
 *
 * 隔离：独立 CODEX_HOME（本应用自己的登录，不读取用户其他 Codex 客户端的凭据）、独立 HOME、仓库外的工作目录；
 * 关闭 shell、联网搜索、多代理、插件等内置能力，项目 AGENTS.md 不注入；线程用只读沙箱。
 * 业务工具仅来自本应用注册的动态工具；Codex 仍可能暴露部分内置工具，命令/改文件/权限审批一律拒绝。
 * app-server 与动态工具在官方文档中标注为 experimental，版本在 package.json 精确锁定。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path';
import readline from 'node:readline';

const require = createRequire(import.meta.url);
const PLATFORM_TARGET: Record<string, string> = { darwin: 'apple-darwin', win32: 'pc-windows-msvc', linux: 'unknown-linux-musl' };
const ARCH_TARGET: Record<string, string> = { arm64: 'aarch64', x64: 'x86_64' };
const platformPackage = `@openai/codex-${process.platform}-${process.arch}/package.json`;
export const CODEX_BIN = path.join(
  path.dirname(require.resolve(platformPackage)), 'vendor',
  `${ARCH_TARGET[process.arch]}-${PLATFORM_TARGET[process.platform]}`, 'bin',
  process.platform === 'win32' ? 'codex.exe' : 'codex',
);

const DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'multi_agent', 'multi_agent_v2', 'goals', 'view_image', 'apps', 'plugins', 'browser_use',
  'browser_use_external', 'computer_use', 'image_generation', 'hooks', 'sleep_tool', 'tool_suggest', 'skill_search',
  'in_app_browser', 'realtime_conversation', 'workspace_dependencies', 'memories',
];

export const LOCKDOWN_ARGS = [
  ...DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
  '-c', 'web_search="disabled"',
  '-c', 'project_doc_max_bytes=0',
  '-c', 'cli_auth_credentials_store="file"',
];

export interface CodexPaths {
  codexHome: string;
  userHome: string;
  workDir: string;
}

export interface CodexAccount {
  signedIn: boolean;
  email: string | null;
  plan: string | null;
}

export interface DynamicTool {
  name: string;
  description: string;
  inputSchema: object;
  handle(args: unknown): Promise<{ text: string; success: boolean }>;
}

export interface TurnResult {
  status: 'completed' | 'interrupted' | 'failed';
  error: string | null;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
type JsonMsg = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string } };

/** 审批类请求一律拒绝时的回复。 */
const DENY: Record<string, unknown> = {
  'item/commandExecution/requestApproval': { decision: 'decline' },
  'item/fileChange/requestApproval': { decision: 'decline' },
  'item/permissions/requestApproval': { permissions: {}, scope: 'turn' },
  'mcpServer/elicitation/request': { action: 'decline', content: null, _meta: null },
  'item/tool/requestUserInput': { answers: {} },
  applyPatchApproval: { decision: { denied: { rejection: '本应用不允许修改文件' } } },
  execCommandApproval: { decision: { denied: { rejection: '本应用不允许执行命令' } } },
};

/** 事件：'account'（登录状态可能变化）、'log'（人话日志）。 */
export class CodexClient extends EventEmitter {
  readonly #paths: CodexPaths;
  #child: ChildProcess | null = null;
  #ready: Promise<void> | null = null;
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  #turn: { threadId: string; tools: Map<string, DynamicTool>; done: (r: TurnResult) => void } | null = null;
  #pendingLoginUrl: string | null = null;

  constructor(paths: CodexPaths) {
    super();
    this.#paths = paths;
  }

  get pendingLoginUrl(): string | null {
    return this.#pendingLoginUrl;
  }

  async account(): Promise<CodexAccount> {
    const r = (await this.#request('account/read', { refreshToken: false })) as {
      account: { type: string; email?: string | null; planType?: string } | null;
      requiresOpenaiAuth: boolean;
    };
    return { signedIn: r.account?.type === 'chatgpt' || !r.requiresOpenaiAuth, email: r.account?.email ?? null, plan: r.account?.planType ?? null };
  }

  async login(): Promise<string> {
    const r = (await this.#request('account/login/start', { type: 'chatgpt' })) as { authUrl: string };
    this.#pendingLoginUrl = r.authUrl;
    return r.authUrl;
  }

  async logout(): Promise<void> {
    await this.#request('account/logout', undefined);
  }

  /** 新开只读线程跑一轮；signal 触发时中断本轮。 */
  async runTurn(opts: { developerInstructions: string; input: string; tools: DynamicTool[]; signal: AbortSignal }): Promise<TurnResult> {
    const started = (await this.#request('thread/start', {
      cwd: this.#paths.workDir,
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
      ephemeral: true,
      serviceName: 'boss-toudi-assistant',
      developerInstructions: opts.developerInstructions,
      dynamicTools: opts.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, inputSchema: t.inputSchema })),
    })) as { thread: { id: string } };
    const threadId = started.thread.id;
    const finished = new Promise<TurnResult>((done) => {
      this.#turn = { threadId, tools: new Map(opts.tools.map((t) => [t.name, t])), done };
    });
    let interrupt = () => {};
    try {
      const turn = (await this.#request('turn/start', { threadId, input: [{ type: 'text', text: opts.input }] })) as { turn: { id: string } };
      interrupt = () => void this.#request('turn/interrupt', { threadId, turnId: turn.turn.id }).catch(() => {});
      if (opts.signal.aborted) interrupt();
      opts.signal.addEventListener('abort', interrupt, { once: true });
      return await finished;
    } finally {
      opts.signal.removeEventListener('abort', interrupt);
      this.#turn = null;
    }
  }

  close(): void {
    this.#child?.stdin?.end();
    this.#child?.kill();
    this.#child = null;
    this.#ready = null;
  }

  #start(): Promise<void> {
    if (this.#ready) return this.#ready;
    const child = spawn(CODEX_BIN, ['app-server', ...LOCKDOWN_ARGS], {
      cwd: this.#paths.workDir,
      env: { ...systemEnvironment(), CODEX_HOME: this.#paths.codexHome, HOME: this.#paths.userHome, USERPROFILE: this.#paths.userHome },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.#child = child;
    child.stderr?.resume();
    readline.createInterface({ input: child.stdout! }).on('line', (line) => this.#onLine(line));
    child.on('exit', (code) => {
      if (this.#child === child) {
        this.#child = null;
        this.#ready = null;
      }
      const err = new Error(`Codex 进程已退出（${code}）`);
      for (const p of this.#pending.values()) p.reject(err);
      this.#pending.clear();
      this.#turn?.done({ status: 'failed', error: err.message });
    });
    child.on('error', (e) => {
      for (const p of this.#pending.values()) p.reject(e);
      this.#pending.clear();
      this.#ready = null;
      this.emit('log', `Codex 启动失败：${e.message}`);
    });
    this.#ready = this.#send('initialize', { clientInfo: { name: 'boss_toudi_assistant', title: 'boss 投递助手', version: '0.1.0' }, capabilities: { experimentalApi: true } }).then(() => {
      this.#write({ method: 'initialized' });
    });
    return this.#ready;
  }

  async #request(method: string, params: unknown): Promise<unknown> {
    await this.#start();
    return this.#send(method, params);
  }

  #send(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex 请求超时：${method}`));
      }, 60_000);
      this.#pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.#write({ id, method, params });
    });
  }

  #write(msg: object): void {
    this.#child?.stdin?.write(`${JSON.stringify(msg)}\n`);
  }

  #onLine(line: string): void {
    let msg: JsonMsg;
    try {
      msg = JSON.parse(line) as JsonMsg;
    } catch {
      return;
    }
    if (msg.id !== undefined && !msg.method) {
      const p = this.#pending.get(msg.id as number);
      this.#pending.delete(msg.id as number);
      if (msg.error) p?.reject(new Error(msg.error.message));
      else p?.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined && msg.method) {
      void this.#onServerRequest(msg.id, msg.method, msg.params ?? {});
      return;
    }
    this.#onNotification(msg.method ?? '', msg.params ?? {});
  }

  async #onServerRequest(id: number | string, method: string, params: Record<string, unknown>): Promise<void> {
    if (method === 'item/tool/call') {
      const result = await this.#callTool(params);
      this.#write({ id, result: { contentItems: [{ type: 'inputText', text: result.text }], success: result.success } });
      return;
    }
    const deny = DENY[method];
    if (deny) {
      this.emit('log', `已拒绝模型的越权请求：${method}`);
      this.#write({ id, result: deny });
      return;
    }
    this.#write({ id, error: { code: -32601, message: `boss 投递助手不支持 ${method}` } });
  }

  async #callTool(params: Record<string, unknown>): Promise<{ text: string; success: boolean }> {
    const turn = this.#turn;
    // 只接受本轮根线程的调用；子线程或过期线程一律拒绝。
    if (!turn || params.threadId !== turn.threadId) return { text: '该线程无权调用本应用工具', success: false };
    const tool = turn.tools.get(String(params.tool));
    if (!tool || params.namespace) return { text: `未知工具 ${String(params.tool)}`, success: false };
    try {
      return await tool.handle(params.arguments);
    } catch (e) {
      return { text: `工具出错：${e instanceof Error ? e.message : String(e)}`, success: false };
    }
  }

  #onNotification(method: string, params: Record<string, unknown>): void {
    if (method === 'turn/completed' && this.#turn && params.threadId === this.#turn.threadId) {
      const turn = params.turn as { status: string; error: { message?: string } | null };
      const status = turn.status === 'completed' || turn.status === 'interrupted' ? turn.status : 'failed';
      this.#turn.done({ status, error: turn.error?.message ?? null });
    } else if (method === 'account/login/completed') {
      this.#pendingLoginUrl = null;
      if (params.success !== true) this.emit('log', `Codex 登录未完成：${String(params.error ?? '已取消')}`);
      this.emit('account');
    } else if (method === 'account/updated') {
      this.emit('account');
    }
  }
}
