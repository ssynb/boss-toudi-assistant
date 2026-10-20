/**
 * 应用服务：把状态、Codex、浏览器站点、发现与执行器组合成 HTTP 接口背后的操作。
 * 发现与执行互斥；任何对外联系只经执行器。
 */
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppState, ApproveRequest, BrowserState, CodexState, DoctorCheck, SaveInputsRequest, StartDiscoveryRequest, TargetPatch } from './contracts.ts';
import { Browser } from './browser.ts';
import { createBossSite, type Site } from './boss.ts';
import { CodexClient } from './codex.ts';
import { runDiscovery } from './discovery.ts';
import { runDoctor } from './doctor.ts';
import { AppError } from './errors.ts';
import { Executor } from './executor.ts';
import { openState, type State } from './state.ts';

export const APP_NAME = 'boss-toudi-assistant';

/** 默认数据目录（不在仓库内，天然不进 Git）。 */
export function defaultDataDir(): string {
  if (process.env.BOSS_DATA_DIR) return path.resolve(process.env.BOSS_DATA_DIR);
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', APP_NAME);
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), APP_NAME);
  return path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), APP_NAME);
}

/** 数据目录布局；docs/architecture.md 有说明。 */
export function dataLayout(dataDir: string) {
  return {
    db: path.join(dataDir, 'state.sqlite'),
    codexHome: path.join(dataDir, 'codex-home'),
    codexUserHome: path.join(dataDir, 'codex-user-home'),
    codexWork: path.join(dataDir, 'codex-work'),
    browserProfile: path.join(dataDir, 'cloak-profile'),
  };
}

export interface AppOptions {
  dataDir: string;
  /** 站点实现；默认用 agent-browser 驱动真实 BOSS。 */
  site?: Site;
}

/** 事件：'changed'（状态有变）、'log'（人话日志文本）。 */
export class App extends EventEmitter {
  readonly #layout: ReturnType<typeof dataLayout>;
  readonly #state: State;
  readonly #codex: CodexClient;
  readonly #site: Site;
  #doctor: Promise<DoctorCheck[]>;
  #codexState: CodexState = { signedIn: false, email: null, plan: null, pendingLoginUrl: null, error: null };
  #discoveryAbort: AbortController | null = null;
  #executor: Executor | null = null;
  #execution: Promise<void> | null = null;
  #discovering: Promise<void> | null = null;
  #starting: Promise<void> | null = null;

  constructor(opts: AppOptions) {
    super();
    this.#layout = dataLayout(opts.dataDir);
    for (const dir of [opts.dataDir, this.#layout.codexHome, this.#layout.codexUserHome, this.#layout.codexWork, this.#layout.browserProfile]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    this.#state = openState(this.#layout.db);
    this.#codex = new CodexClient({ codexHome: this.#layout.codexHome, userHome: this.#layout.codexUserHome, workDir: this.#layout.codexWork });
    this.#codex.on('account', () => void this.#refreshAccount());
    this.#codex.on('log', (t: string) => this.#log(t));
    this.#site =
      opts.site ??
      createBossSite(new Browser({ profileDir: this.#layout.browserProfile, headed: true, namespace: `${APP_NAME}-cloak-${createHash('sha256').update(path.resolve(opts.dataDir)).digest('hex').slice(0, 12)}` }));
    this.#doctor = runDoctor(opts.dataDir);
    void this.#refreshAccount();
  }

  async close(): Promise<void> {
    this.#executor?.pause();
    this.#discoveryAbort?.abort();
    this.#codex.close();
    await Promise.allSettled([this.#starting]);
    await Promise.allSettled([this.#execution, this.#discovering]);
    try {
      await this.#site.close();
    } finally {
      this.#state.close();
    }
  }

  async getState(): Promise<AppState> {
    const [doctor, browser] = await Promise.all([this.#doctor, this.#browserState()]);
    return {
      doctor,
      codex: { ...this.#codexState, pendingLoginUrl: this.#codex.pendingLoginUrl },
      browser,
      ...this.#state.snapshot(),
    };
  }

  // ---------- Codex 登录 ----------

  async login(): Promise<void> {
    await this.#codex.login();
    this.#changed();
  }

  async logout(): Promise<void> {
    await this.#codex.logout();
    await this.#refreshAccount();
  }

  // ---------- 具体要求、简历 ----------

  saveInputs(request: SaveInputsRequest): void {
    this.#assertDiscoveryIdle();
    this.#state.saveInputs(request);
    this.#changed();
  }

  // ---------- 浏览器 ----------

  async openBrowser(): Promise<void> {
    this.#assertDiscoveryIdle();
    if (this.#executor) throw new AppError('batch_running', '批次执行中不能导航浏览器');
    await this.#site.open();
    this.#changed();
  }

  // ---------- 发现 ----------

  startDiscovery(request: StartDiscoveryRequest = { autoSend: false }): Promise<void> {
    if (typeof request?.autoSend !== 'boolean') throw new AppError('bad_request', 'autoSend 须为布尔值');
    const snap = this.#state.snapshot();
    if (snap.batch?.status === 'running') throw new AppError('batch_running', '批次执行中，请先暂停');
    this.#assertDiscoveryIdle();
    if (!snap.resume.text.trim() || !snap.requirements.trim()) throw new AppError('inputs_incomplete', '请先统一保存具体要求和有效简历正文');
    const abort = new AbortController();
    this.#discoveryAbort = abort;
    this.#starting = this.#launchDiscovery(abort, request.autoSend);
    return this.#starting;
  }

  async #launchDiscovery(abort: AbortController, autoSend: boolean): Promise<void> {
    try {
      await this.#refreshAccount();
      if (abort.signal.aborted) {
        this.#discoveryAbort = null;
        return;
      }
      if (!this.#codexState.signedIn) throw new AppError('codex_signed_out', '请先登录 Codex（ChatGPT 账号）');
      this.#state.beginDiscovery(autoSend);
      this.#changed();
      this.#discovering = runDiscovery({ codex: this.#codex, site: this.#site, state: this.#state, signal: abort.signal, log: (t) => this.#log(t) })
        .catch((e: unknown) => ({ message: `发现失败：${e instanceof Error ? e.message : String(e)}`, questions: [] as string[], proposed: 0 }))
        .then(({ message, questions, proposed }) => {
          const outcome = abort.signal.aborted ? '已停止发现。' : message;
          this.#state.finishDiscovery(outcome, abort.signal.aborted ? [] : questions);
          this.#log(outcome);
          return autoSend && !abort.signal.aborted && proposed > 0;
        })
        .catch((e: unknown) => {
          this.#log(`无法保存发现结束状态，请重启后检查：${e instanceof Error ? e.message : String(e)}`);
          return false;
        })
        .then((send) => {
          this.#discoveryAbort = null;
          if (send) this.#autoSend();
          this.#changed();
        });
    } catch (e) {
      this.#discoveryAbort = null;
      throw e;
    }
  }

  stopDiscovery(): void {
    if (!this.#discoveryAbort) return;
    this.#state.requestDiscoveryStop();
    this.#discoveryAbort.abort();
    this.#changed();
  }

  // ---------- 批次 ----------

  patchTarget(id: string, p: TargetPatch): void {
    this.#assertDiscoveryIdle();
    this.#state.patchTarget(id, p);
    this.#changed();
  }

  approve(version: number): void {
    this.#assertDiscoveryIdle();
    this.#state.approve(version);
    this.#changed();
  }

  startBatch(request?: ApproveRequest): void {
    this.#assertDiscoveryIdle();
    if (this.#executor) throw new AppError('batch_running', '批次已在执行');
    if (request !== undefined) {
      if (!request || !Number.isSafeInteger(request.version)) throw new AppError('bad_request', 'version 须为整数');
      this.#state.approve(request.version);
    }
    const executor = new Executor(this.#state, this.#site, () => this.#changed());
    const run = executor.start();
    this.#executor = executor;
    this.#execution = run
      .catch((e: unknown) => {
        this.#log(`执行出错：${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        this.#executor = null;
        const b = this.#state.snapshot().batch;
        this.#log(b?.status === 'done' ? '批次已执行完毕' : `批次已暂停${b?.stopReason ? `：${b.stopReason}` : ''}`);
        this.#changed();
      });
  }

  /** 用户开始自动投递时已预先批准本轮草案：同步批准刚生成的版本并执行，中间没有可插入的修改。 */
  #autoSend(): void {
    try {
      this.startBatch({ version: this.#state.snapshot().batch!.version });
      this.#log('自动投递：已按本轮草案开始执行');
    } catch (e) {
      this.#log(`自动投递未能开始：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  pauseBatch(): void {
    this.#executor?.pause();
  }

  // ---------- 内部 ----------

  #assertDiscoveryIdle(): void {
    if (this.#discoveryAbort || this.#state.snapshot().discovery.status !== 'idle') throw new AppError('busy', '请先停止发现，再修改具体要求或批次');
  }

  async #browserState(): Promise<BrowserState> {
    return this.#site.status().catch(() => ({ page: 'unknown', url: null }));
  }

  async #refreshAccount(): Promise<void> {
    try {
      const a = await this.#codex.account();
      this.#codexState = { ...a, pendingLoginUrl: null, error: null };
    } catch (e) {
      this.#codexState = { signedIn: false, email: null, plan: null, pendingLoginUrl: null, error: `Codex 不可用：${(e as Error).message}` };
    }
    this.#changed();
  }

  #log(text: string): void {
    this.emit('log', { at: new Date().toISOString(), text });
  }

  #changed(): void {
    this.emit('changed');
  }
}
