/**
 * 确定性批次执行器：只执行用户批准的批次，模型不参与。
 *
 * 每个对外步骤先把状态记为 inflight 再动手，页面核实后才记 done；
 * 核实不了记 unknown 并停下整批，unknown 永不自动重试。
 * 暂停只在步骤之间生效，不打断正在进行的步骤。
 */
import type { Batch, Target, ContactIdentity } from './contracts.ts';
import type { State } from './state.ts';

export interface Verified {
  identity?: ContactIdentity;
  ok: boolean;
  evidence: string;
}

export interface GreetingResult extends Verified {
  /** 提交前发现已有本方消息：没有发送本次招呼，执行器应记为 skipped。 */
  skipped?: true;
}

export type OpenJobResult =
  | { kind: 'canContact'; evidence: string } // 岗位页有「立即沟通」
  | { kind: 'alreadyContacted'; evidence: string } // 岗位页显示「继续沟通」等：站点上已有会话
  | { kind: 'missing'; evidence: string } // 岗位已下线或找不到沟通入口
  | { kind: 'blocked'; evidence: string }; // 登录失效、安全验证或风控页

/** 会对 BOSS 产生联系的站点操作，只有执行器调用。 */
export interface WriteSite {
  openJob(t: Target): Promise<OpenJobResult>;
  /** 点「立即沟通」并核实会话已打开。 */
  contact(t: Target): Promise<Verified>;
  /** 读当前会话里本方已发出的消息数（含站点自动发出的默认招呼）。 */
  readChat(t: Target): Promise<{ ourMessages: number; evidence: string }>;
  sendGreeting(t: Target, text: string): Promise<GreetingResult>;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

class Stop {
  readonly reason: string;
  constructor(reason: string) {
    this.reason = reason;
  }
}

export class Executor {
  readonly #state: State;
  readonly #site: WriteSite;
  readonly #onChange: () => void;
  #pauseRequested = false;

  constructor(state: State, site: WriteSite, onChange: () => void = () => {}) {
    this.#state = state;
    this.#site = site;
    this.#onChange = onChange;
  }

  pause(): void {
    this.#pauseRequested = true;
  }

  /** 同步校验批准（未处于有效批准状态时立即抛 not_startable），返回执行到结束、暂停或停下的 Promise。 */
  start(): Promise<void> {
    const batch = this.#state.beginRun();
    this.#onChange();
    return this.#run(batch);
  }

  async #run(batch: Batch): Promise<void> {
    try {
      for (const t of batch.targets) {
        if (!t.removed) await this.#runTarget(t);
      }
      this.#state.finishRun('done', null);
    } catch (e) {
      if (!(e instanceof Stop)) {
        this.#state.finishRun('paused', `执行出错：${errorText(e)}`);
        throw e;
      }
      this.#state.finishRun('paused', e.reason || null);
    } finally {
      this.#onChange();
    }
  }

  #checkpoint(): void {
    if (this.#pauseRequested) throw new Stop('');
  }

  #set(t: Target, step: keyof Target['steps'], value: Target['steps']['contact'], evidence: string, identity?: ContactIdentity): void {
    this.#state.setStep(t, step, value, evidence, identity);
    if (identity) t.contactIdentity = identity;
    t.steps[step] = value;
    this.#onChange();
  }

  #skipRest(t: Target, evidence: string): void {
    if (t.steps.greeting === 'todo') this.#set(t, 'greeting', 'skipped', evidence);
  }

  async #runTarget(t: Target): Promise<void> {
    if (t.steps.contact === 'todo') {
      this.#checkpoint();
      if (this.#state.isContacted(t.jobId)) {
        this.#set(t, 'contact', 'skipped', '此前已联系过或结果未确认，不再联系');
        return this.#skipRest(t, '此前已联系过，不再联系');
      }
      const opened = await this.#site.openJob(t);
      if (opened.kind === 'blocked') throw new Stop(`页面需要处理后才能继续：${opened.evidence}`);
      if (opened.kind === 'missing') {
        this.#set(t, 'contact', 'failed', opened.evidence);
        return this.#skipRest(t, '未能打开沟通入口');
      }
      if (opened.kind === 'alreadyContacted') {
        this.#set(t, 'contact', 'skipped', opened.evidence);
        return this.#skipRest(t, '站点显示已有会话，不再发送');
      }
      this.#checkpoint();
      this.#set(t, 'contact', 'inflight', opened.evidence);
      const r: Verified = await this.#site.contact(t).catch((e: unknown) => ({ ok: false, evidence: `点击后出错：${errorText(e)}` }));
      this.#set(t, 'contact', r.ok ? 'done' : 'unknown', r.evidence, r.ok ? r.identity : undefined);
      if (!r.ok) {
        this.#skipRest(t, '联系结果未确认，不继续');
        throw new Stop(`「${t.company}」联系结果未确认：${r.evidence}`);
      }
    }
    if (t.steps.contact !== 'done') return this.#skipRest(t, '未建立会话');

    if (t.steps.greeting === 'todo') {
      this.#checkpoint();
      const chat = await this.#site.readChat(t);
      if (chat.ourMessages > 0) {
        this.#set(t, 'greeting', 'skipped', chat.evidence);
      } else {
        this.#checkpoint();
        this.#set(t, 'greeting', 'inflight', chat.evidence);
        const r: GreetingResult = await this.#site.sendGreeting(t, t.greeting).catch((e: unknown) => ({ ok: false, evidence: `发送时出错：${errorText(e)}` }));
        this.#set(t, 'greeting', r.ok ? (r.skipped ? 'skipped' : 'done') : 'unknown', r.evidence);
        if (!r.ok) throw new Stop(`「${t.company}」招呼发送结果未确认：${r.evidence}`);
      }
    }
  }
}

