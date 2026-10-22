/**
 * BOSS 已有会话的进入、历史判定与发送前核对。所有联系后的去向（新标签页、路由、弹层）
 * 和重启恢复都走同一条路径：先打开会话页，再开始只读观察历史接口，最后只选择岗位与招聘者
 * 同时匹配的已有会话。
 *
 * 两类证据各管一件事：被动捕获的历史响应证明「历史已完整读到」及其中的本方消息；
 * DOM 证明「当前显示的仍是这个会话」以及历史之后才到达的消息（站点自动招呼、本次发送回显）。
 * 本方消息数 = 两者按 mid 的并集；零只在历史完整成功时成立，任何失败都不当作空。
 * 不重放带安全参数的接口，不保存请求 URL 或消息原文。
 */
import type { ContactIdentity, Target } from './contracts.ts';
import type { Browser } from './browser.ts';
import type { ResponseObservation, ResponseWatch } from './browser-responses.ts';
import type { GreetingResult } from './executor.ts';

export type ChatIdentity = Extract<ContactIdentity, { kind: 'chatId' }>;
type ChatBrowser = Pick<Browser, 'eval' | 'waitFor' | 'clickNth' | 'scrollWithin' | 'fillSelector' | 'press' | 'watchResponses'>;

export const ORIGIN = 'https://www.zhipin.com';
export const CHAT_URL = `${ORIGIN}/web/geek/chat`;
const HISTORY_ENDPOINT = `${ORIGIN}/wapi/zpchat/geek/historyMsg`;
/** 历史超过这么多页仍未见本方消息或结束标记时停止，不无限翻页。 */
const MAX_HISTORY_PAGES = 30;
const MAX_LIST_SCROLLS = 80;
const LIST_VIEWPORT = '.chat-user .user-list-content';
/** 站点输入框的启用状态在内容变化 100ms 防抖后才更新；安静时长须覆盖它，否则 Enter 会被吞掉。 */
const QUIET_MS = 300;

const LIST_ITEMS = '.chat-user .chat-content li[role="listitem"]';
const CONTROLS = '.chat-conversation .message-controls';
const CHAT_INPUT = `${CONTROLS} .chat-input[contenteditable="true"]`;
const SEND_BUTTON = `${CONTROLS} .btn-send`;
const MESSAGES = '.chat-conversation .chat-record .message-item';
const VISIBLE = 'e => e.checkVisibility({checkVisibilityCSS:true,checkOpacity:true})';

const IDENTITY_CHANGED = '当前会话的岗位或招聘者身份不符：请在 BOSS 切回原目标会话，再点击继续；不要重新联系';

/** 历史响应缺失、失败或不连续：会话已进入，但不能据此判断本方消息。 */
export class HistoryError extends Error {}

/** 只能作为防重复联系的证据，不能代替目标岗位的会话身份。 */
export class OtherJobConversationError extends Error {
  constructor() { super('同一招聘者已有其他岗位会话，不重复联系'); }
}

interface Observation {
  jobId: string;
  document: number;
  revision: number;
  watch: ResponseWatch;
  recruiterId: string;
  uid: string;
  friendId: string;
  /** 完整历史或首个含本方消息的前缀里，本方消息的 mid。 */
  historyOwn: Set<string>;
  /** 上次核对时 DOM 里已显示的消息 mid；会话被切走或重新加载时会缺少旧 mid。 */
  shown: Set<string>;
}

interface PageState {
  document: number;
  identity: boolean;
  uid: string | null;
  friendId: string | null;
  items: Array<{ mid: string | null; self: boolean }>;
}

const js = JSON.stringify;

function pageState(t: Target, id: ChatIdentity): string {
  return `(() => {
    const matches = v => v?.encryptJobId === ${js(id.jobId)} && v?.encryptBossId === ${js(id.recruiterId)};
    const selected = document.querySelector('.chat-conversation')?.__vue__?.selectedFriend$;
    const header = document.querySelector('.chat-conversation .top-info-content')?.__vue__?.conversation$;
    const record = document.querySelector('.chat-conversation .chat-record')?.__vue__;
    const identity = matches(selected) && matches(header) && matches(record?.selectedFriend$) && matches(record?.conversation$)
      && header.companyName === ${js(t.company)};
    const uid = window._PAGE?.uid;
    return {
      identity,
      document: performance.timeOrigin,
      uid: uid == null ? null : String(uid),
      friendId: selected?.friendId == null ? null : String(selected.friendId),
      items: [...document.querySelectorAll(${js(MESSAGES)})].map(e => ({ mid: e.getAttribute('data-mid'), self: e.classList.contains('item-myself') })),
    };
  })()`;
}

function matchingIndices(id: ChatIdentity): string {
  return `(() => {
    const viewport = document.querySelector(${js(LIST_VIEWPORT)})?.getBoundingClientRect();
    return [...document.querySelectorAll(${js(LIST_ITEMS)})].map((e,index) => ({source:e.__vue__?.$props?.source,index,rect:e.getBoundingClientRect()}))
      .filter(e => e.source?.encryptJobId === ${js(id.jobId)} && e.source?.encryptBossId === ${js(id.recruiterId)}
        && (!viewport || ((e.rect.top + e.rect.bottom) / 2 > viewport.top && (e.rect.top + e.rect.bottom) / 2 < viewport.bottom))).map(e => e.index);
  })()`;
}

/** root 子树最近 ms 毫秒内没有任何变化；首次求值时安装观察者。 */
export function domQuiet(selector: string, ms: number): string {
  return `(() => {
    const root = document.querySelector(${js(selector)});
    if (!root) return false;
    const key = Symbol.for('boss-toudi.quiet');
    if (!root[key]) {
      const state = root[key] = { at: performance.now() };
      new MutationObserver(() => { state.at = performance.now(); }).observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
    }
    return performance.now() - root[key].at >= ${ms};
  })()`;
}

const CONTROLS_READY = `(() => {
  const visible = ${VISIBLE};
  const inputs = [...document.querySelectorAll(${js(CHAT_INPUT)})], buttons = [...document.querySelectorAll(${js(SEND_BUTTON)})];
  return inputs.length === 1 && visible(inputs[0]) && buttons.length === 1 && visible(buttons[0]);
})()`;

function inputState(text: string): string {
  return `(() => {
    const visible = ${VISIBLE};
    const input = document.querySelector(${js(CHAT_INPUT)}), button = document.querySelector(${js(SEND_BUTTON)});
    return {
      exact: Boolean(input) && input.innerText.trim() === ${js(text.trim())},
      sendable: Boolean(button) && visible(button) && !button.disabled && !button.classList.contains('disabled'),
    };
  })()`;
}

function deliveryState(t: Target, id: ChatIdentity, text: string, before: Set<string>): string {
  // BOSS MessageStatus 将服务端确认后的 DELIVERED/READ 渲染为 status-delivery/status-read；
  // 乐观消息只有 status-loading，失败为 status-error，不以新 mid 或原文回显冒充送达。
  return `(() => {
    if (!(${pageState(t, id)}).identity) return 'identity';
    const matches = [...document.querySelectorAll(${js(MESSAGES)})].filter(e => e.classList.contains('item-myself')
      && e.getAttribute('data-mid') && !${js([...before])}.includes(e.getAttribute('data-mid')) && (e.querySelector('.text-content')?.innerText || '').trim() === ${js(text.trim())});
    if (matches.some(e => e.querySelector('.message-status.status-error'))) return 'failed';
    if (matches.length === 1 && matches[0].querySelector('.message-status.status-delivery, .message-status.status-read')) return 'delivered';
    return 'pending';
  })()`;
}

type RawMessage = { mid?: unknown; from?: { uid?: unknown }; to?: { uid?: unknown } };
type HistoryBody = { code?: unknown; zpData?: { messages?: unknown; hasMore?: unknown; minMsgId?: unknown } } | null;

function historyPage(event: ResponseObservation): { messages: RawMessage[]; hasMore: boolean; minMsgId: unknown } {
  if (event.kind === 'failed') throw new HistoryError('消息历史请求失败，不能证明会话没有本方消息');
  const data = (event.body as HistoryBody)?.zpData;
  if (event.status !== 200 || (event.body as HistoryBody)?.code !== 0 || !Array.isArray(data?.messages) || typeof data.hasMore !== 'boolean') {
    throw new HistoryError('消息历史响应不是完整成功结果，不能证明会话没有本方消息');
  }
  return { messages: data.messages, hasMore: data.hasMore, minMsgId: data.minMsgId };
}

function messageId(m: RawMessage): string {
  const mid = m.mid;
  if (!(typeof mid === 'number' && Number.isSafeInteger(mid) && mid > 0) && !(typeof mid === 'string' && /^\d+$/.test(mid))) {
    throw new HistoryError('消息历史里有无法识别的消息编号，不能证明会话没有本方消息');
  }
  return String(mid);
}

/**
 * 按请求顺序消费目标招聘者的历史分页：首批游标为 0，后续页的游标必须等于上一页的最小消息编号
 * （与站点自身翻页一致）；见到本方消息即可下结论，否则必须读到明确的「没有更多」。
 */
async function readHistory(watch: ResponseWatch, id: ChatIdentity, account: { uid: string; friendId: string }, loadOlder: () => Promise<void>): Promise<{ own: Set<string>; revision: number }> {
  const seen = new Set<string>();
  const own = new Set<string>();
  let expected: { page: string; cursor: string } | null = null;
  for (;;) {
    const event = await watch.next().catch((e: Error) => { throw new HistoryError(`未取得完整消息历史（${e.message}），不能证明会话没有本方消息`); });
    const query = new URL(event.url).searchParams;
    if (query.get('bossId') !== id.recruiterId) continue;
    const page = query.get('page'), cursor = query.get('maxMsgId');
    if (page === '1' && cursor === '0') {
      seen.clear();
      own.clear();
    } else if (!expected || page !== expected.page || cursor !== expected.cursor) {
      throw new HistoryError('消息历史分页游标不连续，不能证明会话没有本方消息');
    }
    const { messages, hasMore, minMsgId } = historyPage(event);
    const mids = messages.map(messageId);
    const fresh = mids.filter(mid => !seen.has(mid));
    messages.forEach((m, i) => {
      seen.add(mids[i]!);
      const from = String(m.from?.uid), to = String(m.to?.uid);
      const self = from === account.uid && to === account.friendId;
      const friend = from === account.friendId && to === account.uid;
      if (!self && !friend) throw new HistoryError('历史消息的发送者、接收者与当前账号和招聘者归属不一致，停止发送');
      if (self) own.add(mids[i]!);
    });
    if (own.size || !hasMore) return { own, revision: event.revision };
    if (!fresh.length) throw new HistoryError('消息历史分页没有进展，不能证明会话没有本方消息');
    const next: number = Number(page) + 1;
    if (next > MAX_HISTORY_PAGES) throw new HistoryError('消息历史过长，未能读到结束，不能证明会话没有本方消息');
    const nextCursor = typeof minMsgId === 'number' && minMsgId > 0 ? String(minMsgId) : String(Math.min(...mids.map(Number)));
    expected = { page: String(next), cursor: nextCursor };
    await loadOlder();
  }
}

export interface ChatSession {
  close(): Promise<void>;
  /** 选中目标已有会话并读取完整历史；不点击任何联系入口。 */
  enter(t: Target, id: ChatIdentity, newlyContacted?: boolean): Promise<void>;
  ownMessages(t: Target, id: ChatIdentity): Promise<number>;
  sendGreeting(t: Target, id: ChatIdentity, text: string): Promise<GreetingResult>;
}

export function createChatSession(browser: ChatBrowser, goto: (url: string) => Promise<void>): ChatSession {
  let observation: Observation | null = null;

  async function close(): Promise<void> {
    const previous = observation;
    observation = null;
    await previous?.watch.close();
  }

  function current(obs: Observation): boolean {
    try { return obs.watch.revision === obs.revision; }
    catch { return false; }
  }

  const read = (t: Target, id: ChatIdentity) => browser.eval<PageState>(pageState(t, id));

  async function loadOlder(): Promise<void> {
    // 站点在内容不足一屏时自动加载下一页，否则要滚到顶部；等列表安静后滚动，两种情况都覆盖。
    await browser.waitFor(domQuiet('.chat-conversation .chat-record', QUIET_MS), '会话历史渲染');
    const height = await browser.eval<number>(`document.querySelector('.chat-conversation .chat-message')?.scrollHeight ?? 0`);
    if (height) await browser.scrollWithin('.chat-conversation .chat-message', 'up', height);
  }

  function listState(id: ChatIdentity): string {
    return `(() => {
      const state = document.querySelector('.chat-user').__vue__;
      const friends = [...state.list$, ...state.topList$];
      return { count:friends.length, hasMore:state.hasMore$,
        exact:friends.filter(s => s.encryptJobId === ${js(id.jobId)} && s.encryptBossId === ${js(id.recruiterId)}).length,
        otherJob:friends.some(s => s.encryptBossId === ${js(id.recruiterId)} && Boolean(s.encryptJobId) && s.encryptJobId !== ${js(id.jobId)}) };
    })()`;
  }

  async function findConversation(id: ChatIdentity, newlyContacted: boolean): Promise<void> {
    await browser.waitFor(`(() => {const s=document.querySelector('.chat-user')?.__vue__;return Array.isArray(s?.list$)&&Array.isArray(s?.topList$)})()`, '会话列表初始化');
    const expression = listState(id);
    for (let page = 0; page < MAX_LIST_SCROLLS; page++) {
      const data = await browser.eval<{count:number;exact:number;otherJob:boolean;hasMore?:boolean}>(expression);
      if (data.exact === 1) return;
      if (data.exact > 1) throw new Error('无法唯一识别已存在的目标会话，停止后续动作');
      if (data.hasMore === false) {
        if (newlyContacted) {
          await browser.waitFor(`(${expression}).exact > 0`, '联系后新会话出现').catch(() => { throw new Error('联系后等待新会话出现在列表超时，不重复联系'); });
          newlyContacted = false;
          continue;
        }
        if (data.otherJob) throw new OtherJobConversationError();
        throw new Error('会话列表已加载完，未找到目标会话，停止后续动作');
      }
      if (data.hasMore !== true) throw new Error('会话列表分页状态未知，不能确认目标不存在');
      const height = await browser.eval<number>(`document.querySelector(${js(LIST_VIEWPORT)})?.scrollHeight ?? 0`);
      if (!height) throw new Error('找不到会话列表滚动区域，无法加载更多会话');
      await browser.scrollWithin(LIST_VIEWPORT, 'down', height);
      await browser.waitFor(`(() => {const s=${expression};return s.exact>0||s.count!==${data.count}||s.hasMore!==true})()`, '会话列表分页加载')
        .catch(() => { throw new Error('会话列表加载更多超时，不能确认目标不存在'); });
    }
    throw new Error('会话列表加载达到上限，不能确认目标不存在');
  }

  async function locateConversation(id: ChatIdentity, newlyContacted: boolean): Promise<number> {
    await findConversation(id, newlyContacted);
    // 分页查找可能停在底部，而新会话可能插入顶部。已渲染时不滚动，否则从顶部查找。
    if (!(await browser.eval<number[]>(matchingIndices(id))).length) {
      const total = await browser.eval<number>(`document.querySelector(${js(LIST_VIEWPORT)})?.scrollHeight ?? 0`);
      if (total) {
        await browser.scrollWithin(LIST_VIEWPORT, 'up', total);
        await browser.waitFor(domQuiet('.chat-user', QUIET_MS), '会话列表滚动渲染');
      }
    }
    for (let step = 0; step <= MAX_LIST_SCROLLS; step++) {
      const indices = await browser.eval<number[]>(matchingIndices(id));
      if (indices.length === 1) return indices[0]!;
      if (indices.length > 1) throw new Error('目标会话渲染出多个匹配行，停止后续动作');
      const scroll = await browser.eval<{ top: number; height: number; total: number } | null>(`(() => {
        const e = document.querySelector(${js(LIST_VIEWPORT)});
        return e ? {top:e.scrollTop,height:e.clientHeight,total:e.scrollHeight} : null;
      })()`);
      if (!scroll || !scroll.height || scroll.top + scroll.height >= scroll.total || step === MAX_LIST_SCROLLS) break;
      await browser.scrollWithin(LIST_VIEWPORT, 'down', scroll.height);
      await browser.waitFor(domQuiet('.chat-user', QUIET_MS), '会话列表滚动渲染');
    }
    throw new Error('会话列表滚动到底或达到上限，目标行仍未渲染，停止后续动作');
  }

  async function enter(t: Target, id: ChatIdentity, newlyContacted = false): Promise<void> {
    await close();
    // 先找到精确身份并滚动定位，再开启观察，最后选择目标触发首批历史请求。
    await goto(CHAT_URL);
    const index = await locateConversation(id, newlyContacted);
    const watch = await browser.watchResponses(HISTORY_ENDPOINT);
    try {
      await browser.clickNth(LIST_ITEMS, index);
      await browser.waitFor(`(${pageState(t, id)}).identity`, '当前会话身份同步');
      const page = await read(t, id);
      if (page.uid === null || page.friendId === null) throw new Error('会话缺少账号或招聘者编号，不能核对消息归属');
      const account = { uid: page.uid, friendId: page.friendId };
      const history = await readHistory(watch, id, account, loadOlder);
      const proof = { jobId: t.jobId, recruiterId: id.recruiterId, ...account, document: page.document,
        revision: history.revision, watch, historyOwn: history.own, shown: new Set<string>() };
      if (!current(proof)) throw new HistoryError('消息历史观察已变化，旧历史不能证明当前会话');
      observation = proof;
    } catch (e) {
      await watch.close();
      throw e;
    }
  }

  /** 当前页面仍显示同一会话且没有重新加载时返回本方消息数，否则返回 null。 */
  async function measure(t: Target, id: ChatIdentity): Promise<number | null> {
    const obs = observation;
    if (!obs || obs.jobId !== t.jobId || obs.recruiterId !== id.recruiterId || !current(obs)) return null;
    const page = await read(t, id);
    const shown = new Set(page.items.flatMap(item => item.mid ? [item.mid] : []));
    if (!current(obs) || page.document !== obs.document || !page.identity || page.uid !== obs.uid || page.friendId !== obs.friendId || [...obs.shown].some(mid => !shown.has(mid))) return null;
    obs.shown = shown;
    const own = new Set(obs.historyOwn);
    let pendingOwn = 0;
    for (const item of page.items) {
      if (!item.self) continue;
      if (item.mid) own.add(item.mid);
      else pendingOwn++;
    }
    return own.size + pendingOwn;
  }

  async function ownMessages(t: Target, id: ChatIdentity): Promise<number> {
    const current = await measure(t, id);
    if (current !== null) return current;
    await enter(t, id);
    const fresh = await measure(t, id);
    if (fresh === null) throw new Error(IDENTITY_CHANGED);
    return fresh;
  }

  return {
    close,
    enter,
    ownMessages,

    async sendGreeting(t, id, text) {
      if (await ownMessages(t, id)) return { ok: true, skipped: true, evidence: '填写前已有本方消息，未发送本次招呼' };
      if (!(await browser.eval<boolean>(CONTROLS_READY))) return { ok: false, evidence: '会话页找不到唯一可见的输入框和发送按钮，未填写' };
      const beforeFill = await measure(t, id);
      if (beforeFill === null) return { ok: false, evidence: '填写前会话或历史证明已失效，未填写' };
      if (beforeFill) return { ok: true, skipped: true, evidence: '填写前已有本方消息，未发送本次招呼' };
      await browser.fillSelector(CHAT_INPUT, text);
      await browser.waitFor(domQuiet(CONTROLS, QUIET_MS), '招呼输入及控件稳定');
      const own = await measure(t, id);
      if (own === null) return { ok: false, evidence: '填写后当前会话身份或历史证明已变化，未发送' };
      if (own) return { ok: true, skipped: true, evidence: '提交前出现本方消息，未发送本次招呼' };
      const input = await browser.eval<{ exact: boolean; sendable: boolean }>(inputState(text));
      if (!input.exact) return { ok: false, evidence: '输入框内容与批准原文不一致，未发送' };
      if (!input.sendable) return { ok: false, evidence: '发送按钮不可用，未发送' };
      const beforeSubmit = await measure(t, id);
      if (beforeSubmit === null) return { ok: false, evidence: '提交前会话身份或历史证明已失效，未发送' };
      if (beforeSubmit) return { ok: true, skipped: true, evidence: '提交前出现本方消息，未发送本次招呼' };
      const before = observation!.shown;
      await browser.press('Enter');
      const delivery = deliveryState(t, id, text, before);
      await browser.waitFor(`(${delivery}) !== 'pending'`, '招呼送达确认');
      const delivered = await browser.eval<string>(delivery) === 'delivered' && await measure(t, id) !== null;
      return { ok: delivered, evidence: delivered ? '目标会话中的招呼原文已显示送达或已读' : '发送结果未获目标会话送达确认，不重试' };
    },
  };
}
