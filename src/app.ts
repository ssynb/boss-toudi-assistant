/**
 * 应用服务：把状态、Codex、浏览器站点、发现与执行器组合成 HTTP 接口背后的操作。
 * 独立任务互斥；边找边投在同一任务内串行发现与单目标执行，任何联系只经执行器。
 */
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHAT_MESSAGE_MAX_CHARS, DAILY_CONTACT_LIMIT, type ChatRequest, type AppState, type ApproveRequest, type BrowserState, type CodexState, type DoctorCheck, type SaveInputsRequest, type TargetPatch } from './contracts.ts';
import { Browser } from './browser.ts';
import { SUPPORTED_CITIES, createBossSite, type Site } from './boss.ts';
import { CodexClient } from './codex.ts';
import { runDiscovery } from './discovery.ts';
import { runResearch } from './research.ts';
import { askAdvisor, type AdvisorAction } from './advisor.ts';
import { requireQuota, type SearchPlan } from './search-plan.ts';
import { runDoctor } from './doctor.ts';
import { AppError } from './errors.ts';
import { Executor } from './executor.ts';
import { openState, type State, type DraftTarget } from './state.ts';

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
  #assistantAbort: AbortController | null = null;
  #assistantTask: Promise<void> | null = null;
  #executor: Executor | null = null;
  #execution: Promise<void> | null = null;

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
    this.#assistantAbort?.abort();
    this.#codex.close();
    await Promise.allSettled([this.#execution, this.#assistantTask]);
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
      supportedCities: [...SUPPORTED_CITIES],
      dailyContactLimit: DAILY_CONTACT_LIMIT,
      codex: { ...this.#codexState, pendingLoginUrl: this.#codex.pendingLoginUrl },
      browser,
      ...this.#state.snapshot(),
    };
  }

  // ---------- Codex 登录 ----------

  async login(): Promise<void> {
    this.#assertIdle();
    await this.#codex.login();
    this.#changed();
  }

  async logout(): Promise<void> {
    this.#assertIdle();
    await this.#codex.logout();
    await this.#refreshAccount();
  }

  // ---------- 具体要求、简历 ----------

  saveInputs(request: SaveInputsRequest): void {
    this.#assertIdle();
    this.#state.saveInputs(request);
    this.#changed();
  }

  // ---------- 浏览器 ----------

  async openBrowser(): Promise<void> {
    this.#assertIdle();
    if (this.#executor) throw new AppError('batch_running', '批次执行中不能导航浏览器');
    await this.#site.open();
    this.#changed();
  }

  // ---------- 对话驱动任务 ----------

  async #deliver(plan: SearchPlan, abort: AbortController): Promise<void> {
    requireQuota(plan.directions.reduce((sum, direction) => sum + direction.count, 0), this.#state.snapshot().contactedToday);
    this.#state.beginDiscovery(plan.sendNow, plan.directions.map(({ name, count }) => ({ name, count, selected: 0 })), plan);
    this.#changed();
    const outcome = await runDiscovery({
      codex: this.#codex, site: this.#site, state: this.#state, plan, signal: abort.signal,
      log: text => { this.#log(text); this.#changed(); }, node: text => this.#chatNode(text),
      accept: draft => this.#sendSelected(draft, abort),
    });
    if (plan.sendNow && outcome.proposed > 0) {
      this.#state.finishRun(outcome.status === 'completed' ? 'done' : 'paused', outcome.status === 'completed' ? null : outcome.message);
      outcome.message += this.#executionSummary();
    }
    this.#state.finishDiscovery(outcome.message, outcome);
    this.#executor = null;
    this.#assistantAbort = null;
    this.#chatNode(outcome.message);
  }

  async #sendSelected(draft: DraftTarget, abort: AbortController): Promise<string | null> {
    abort.signal.throwIfAborted();
    const target = this.#state.appendStreamingTarget(draft);
    this.#executor ??= new Executor(this.#state, this.#site, () => this.#changed());
    const running = await this.#executor.runTarget(target.id);
    this.#chatNode(this.#executionSummary());
    return running ? null : this.#state.snapshot().batch?.stopReason || '已暂停执行';
  }

  #executionSummary(): string {
    const targets = this.#state.snapshot().batch?.targets ?? [];
    const count = { delivered: 0, skipped: 0, failed: 0, unknown: 0, pending: 0 };
    for (const target of targets) {
      const steps = Object.values(target.steps);
      if (steps.includes('unknown') || steps.includes('inflight')) count.unknown++;
      else if (steps.includes('failed')) count.failed++;
      else if (target.steps.greeting === 'done') count.delivered++;
      else if (target.removed || steps.includes('skipped')) count.skipped++;
      else count.pending++;
    }
    return `入选 ${targets.length} 个，送达 ${count.delivered} 个，跳过 ${count.skipped} 个，失败 ${count.failed} 个，未确认 ${count.unknown} 个，待执行 ${count.pending} 个。`;
  }

  async #research(city: string, abort: AbortController): Promise<void> {
    this.#state.beginResearch(city);
    this.#changed();
    try {
      await runResearch({
        codex: this.#codex, site: this.#site, state: this.#state, city, signal: abort.signal,
        progress: text => { this.#state.researchProgress(text); this.#chatNode(text); },
        completed: direction => { this.#state.addResearchDirection(direction); this.#chatNode(`${direction.name}：样本 ${direction.sampled} 个，匹配 ${direction.matched} 个。`); },
      });
      this.#state.finishResearch('调研完成，结果仅代表本轮实际 JD 抽样。');
    } catch (error) {
      this.#state.finishResearch(abort.signal.aborted ? '已停止调研，已完成方向保留。' : `调研失败：${error instanceof Error ? error.message : String(error)}；已完成方向保留。`, abort.signal.aborted ? 'stopped' : 'failed');
    }
    this.#assistantAbort = null;
    this.#chatNode(this.#state.snapshot().research.message!);
  }

  stopDiscovery(): void {
    const state = this.#state.snapshot();
    if (state.discovery.status === 'idle' && !state.chat.pending) return;
    this.#state.requestDiscoveryStop();
    this.#executor?.pause();
    this.#assistantAbort?.abort();
    this.#changed();
  }

  stopResearch(): void {
    const state = this.#state.snapshot();
    if (state.research.status === 'idle' && !state.chat.pending) return;
    this.#state.requestResearchStop();
    this.#assistantAbort?.abort();
    this.#changed();
  }

  startChat(request: ChatRequest): void {
    this.#assertAssistantIdle();
    this.#state.beginChat(request?.message);
    const abort = new AbortController();
    this.#assistantAbort = abort;
    this.#changed();
    this.#assistantTask = this.#answerChat(abort)
      .catch(error => { this.#log(`无法保存对话终态，请重启后检查：${String(error)}`); })
      .finally(() => { if (this.#assistantAbort === abort) this.#assistantAbort = null; this.#changed(); });
  }

  async #answerChat(abort: AbortController): Promise<void> {
    try {
      await this.#refreshAccount();
      abort.signal.throwIfAborted();
      if (!this.#codexState.signedIn) throw new AppError('codex_signed_out', '请先登录 Codex（ChatGPT 账号）');
      const action = await askAdvisor(this.#codex, abort.signal, this.#state.snapshot(), this.#state.recentTask());
      abort.signal.throwIfAborted();
      if (action.kind === 'reply') { this.#state.finishChat(action.text); this.#assistantAbort = null; return; }
      const recap = action.kind === 'research' ? `开始只读调研，城市：${action.city}。` : action.kind === 'delivery'
        ? `本轮沿用或确认的条件：${action.plan.city}，${action.plan.salaryMinK === null ? '薪资不限' : `月薪区间上限至少${action.plan.salaryMinK}K`}，${action.plan.criteria}。方向配额：${action.plan.directions.map(d => `${d.name}${d.count}个`).join('、')}。${action.plan.sendNow ? '找到一个就执行一个，配额按入选计，送达/跳过等结果另计。' : '仅保存草稿。'}`
        : '开始投递已保存的批次。';
      this.#state.finishChat(recap.slice(0, CHAT_MESSAGE_MAX_CHARS));
      await this.#runAction(action, abort);
    } catch (error) {
      const message = abort.signal.aborted ? '任务已停止，未开始新的联系。' : `任务失败：${error instanceof Error ? error.message : String(error)}`;
      if (this.#assistantAbort === abort) this.#assistantAbort = null;
      if (this.#state.snapshot().chat.pending) this.#state.finishChat(message.slice(0, CHAT_MESSAGE_MAX_CHARS));
      else this.#chatNode(message);
    }
  }

  async #runAction(action: Exclude<AdvisorAction, { kind: 'reply' }>, abort: AbortController): Promise<void> {
    if (action.kind === 'delivery') return this.#deliver(action.plan, abort);
    if (action.kind === 'research') return this.#research(action.city, abort);
    this.#executeBatch({ version: this.#state.snapshot().batch!.version });
    await this.#execution;
  }

  #chatNode(text: string): void {
    let remaining = text;
    while (remaining.length > CHAT_MESSAGE_MAX_CHARS) {
      const newline = remaining.lastIndexOf('\n', CHAT_MESSAGE_MAX_CHARS);
      const end = newline > 0 ? newline : CHAT_MESSAGE_MAX_CHARS;
      this.#state.appendAssistant(remaining.slice(0, end));
      remaining = remaining.slice(end + (newline > 0 ? 1 : 0));
    }
    if (remaining.trim()) this.#state.appendAssistant(remaining);
    this.#log(text);
    this.#changed();
  }

  clearChat(): void {
    this.#assertAssistantIdle();
    this.#state.clearChat();
    this.#changed();
  }

  #assertAssistantIdle(): void {
    if (this.#executor || this.#state.snapshot().batch?.status === 'running') throw new AppError('batch_running', '批次执行中，请先暂停');
    this.#assertIdle();
  }

  // ---------- 批次 ----------

  patchTarget(id: string, p: TargetPatch): void {
    this.#assertIdle();
    this.#state.patchTarget(id, p);
    this.#changed();
  }

  approve(version: number): void {
    this.#assertIdle();
    this.#state.approve(version);
    this.#changed();
  }

  startBatch(request?: ApproveRequest): void {
    this.#assertIdle();
    this.#executeBatch(request);
  }

  #executeBatch(request?: ApproveRequest): void {
    if (this.#executor) throw new AppError('batch_running', '批次已在执行');
    const snapshot = this.#state.snapshot();
    requireQuota(snapshot.batch?.targets.filter(target => !target.removed && target.steps.contact === 'todo' && !this.#state.isContacted(target.jobId)).length ?? 0, snapshot.contactedToday);
    if (request !== undefined) {
      if (!request || !Number.isSafeInteger(request.version)) throw new AppError('bad_request', 'version 须为整数');
      this.#state.approve(request.version);
    }
    this.#state.beginSavedTask();
    const executor = new Executor(this.#state, this.#site, () => this.#changed());
    let run: Promise<void>;
    try { run = executor.start(); }
    catch (error) {
      this.#state.finishRecentTask(`执行未开始：${error instanceof Error ? error.message : String(error)}`, 'failed');
      throw error;
    }
    this.#executor = executor;
    this.#execution = run
      .catch((e: unknown) => {
        this.#log(`执行出错：${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        this.#executor = null;
        this.#assistantAbort = null;
        const b = this.#state.snapshot().batch;
        const result = (b?.status === 'done' ? '批次已执行完毕。' : `批次已暂停${b?.stopReason ? `：${b.stopReason}` : ''}。`) + this.#executionSummary();
        this.#state.finishRecentTask(result, b?.status === 'done' ? 'completed' : 'stopped');
        this.#chatNode(result);
        this.#changed();
      });
  }

  pauseBatch(): void {
    const discovery = this.#state.snapshot().discovery;
    if (discovery.status !== 'idle' && discovery.autoSend) this.stopDiscovery();
    else this.#executor?.pause();
  }

  // ---------- 内部 ----------

  #assertIdle(): void {
    const state = this.#state.snapshot();
    if (this.#assistantAbort || state.discovery.status !== 'idle' || state.research.status !== 'idle' || state.chat.pending) {
      throw new AppError('busy', '发现、调研或对话正在运行，请先等待结束或停止');
    }
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
