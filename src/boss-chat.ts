/**
 * BOSS 已有会话的进入、历史判定与发送前核对。所有联系后的去向（新标签页、路由、弹层）
 * 和重启恢复都走同一条路径：先开始只读观察历史接口，再打开会话页并只选择岗位与招聘者
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
type ChatBrowser = Pick<Browser, 'eval' | 'waitFor' | 'clickSelector' | 'fillSelector' | 'press' | 'watchResponses'>;

export const ORIGIN = 'https://www.zhipin.com';
export const CHAT_URL = `${ORIGIN}/web/geek/chat`;
const HISTORY_ENDPOINT = `${ORIGIN}/wapi/zpchat/geek/historyMsg`;
/** 历史超过这么多页仍未见本方消息或结束标记时停止，不无限翻页。 */
const MAX_HISTORY_PAGES = 30;
/** 站点输入框的启用状态在内容变化 100ms 防抖后才更新；安静时长须覆盖它，否则 Enter 会被吞掉。 */
const QUIET_MS = 300;

const LIST_ITEMS = '.chat-user .chat-content li[role="listitem"]';
const CONTROLS = '.chat-conversation .message-controls';
const CHAT_INPUT = `${CONTROLS} .chat-input[contenteditable="true"]`;
const SEND_BUTTON = `${CONTROLS} .btn-send`;
const MESSAGES = '.chat-conversation .chat-record .message-item[data-mid]';
const VISIBLE = 'e => e.checkVisibility({checkVisibilityCSS:true,checkOpacity:true})';

const IDENTITY_CHANGED = '当前会话的岗位或招聘者身份不符：请在 BOSS 切回原目标会话，再点击继续；不要重新联系';

/** 历史响应缺失、失败或不连续：会话已进入，但不能据此判断本方消息。 */
export class HistoryError extends Error {}

interface Observation {
  recruiterId: string;
  uid: string;
  friendId: string;
  /** 完整历史或首个含本方消息的前缀里，本方消息的 mid。 */
  historyOwn: Set<string>;
  /** 上次核对时 DOM 里已显示的消息 mid；会话被切走或重新加载时会缺少旧 mid。 */
  shown: Set<string>;
}

interface PageState {
  identity: boolean;
  uid: string | null;
  friendId: string | null;
  items: Array<{ mid: string; self: boolean }>;
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
      uid: uid == null ? null : String(uid),
      friendId: selected?.friendId == null ? null : String(selected.friendId),
      items: [...document.querySelectorAll(${js(MESSAGES)})].map(e => ({ mid: e.getAttribute('data-mid'), self: e.classList.contains('item-myself') })),
    };
  })()`;
}

const TARGET_MARK = 'data-boss-toudi-target';

/** 标记岗位与招聘者同时匹配的列表项并返回匹配数；点击按标记定位，不依赖兄弟节点位置。 */
function markMatches(id: ChatIdentity): string {
  return `(() => {
    const items = [...document.querySelectorAll(${js(LIST_ITEMS)})];
    items.forEach(e => e.removeAttribute(${js(TARGET_MARK)}));
    const matches = items.filter(e => e.__vue__?.$props?.source?.encryptJobId === ${js(id.jobId)} && e.__vue__.$props.source.encryptBossId === ${js(id.recruiterId)});
    matches.forEach(e => e.setAttribute(${js(TARGET_MARK)}, ''));
    return matches.length;
  })()`;
}

/** root 子树最近 ms 毫秒内没有任何变化；首次求值时安装观察者。 */
function quiet(selector: string, ms: number): string {
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

const SCROLL_HISTORY_TOP = `(() => {
  let e = document.querySelector(${js(MESSAGES)})?.parentElement;
  while (e && !(e.scrollHeight > e.clientHeight && /auto|scroll/.test(getComputedStyle(e).overflowY))) e = e.parentElement;
  if (e) e.scrollTop = 0;
  return true;
})()`;

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

function echoed(t: Target, id: ChatIdentity, text: string, before: Set<string>): string {
  return `(${pageState(t, id)}).identity && [...document.querySelectorAll(${js(MESSAGES)})].some(e => e.classList.contains('item-myself')
    && !${js([...before])}.includes(e.getAttribute('data-mid')) && (e.querySelector('.text-content')?.innerText || '').trim() === ${js(text.trim())})`;
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
async function readHistory(watch: ResponseWatch, id: ChatIdentity, account: { uid: string; friendId: string }, loadOlder: () => Promise<void>): Promise<Set<string>> {
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
      if (String(m.from?.uid) !== account.uid) return;
      if (String(m.to?.uid) !== account.friendId) throw new HistoryError('历史里的本方消息接收者与当前招聘者归属不一致，停止发送');
      own.add(mids[i]!);
    });
    if (own.size) return own;
    if (!hasMore) return own;
    if (!fresh.length) throw new HistoryError('消息历史分页没有进展，不能证明会话没有本方消息');
    const next: number = Number(page) + 1;
    if (next > MAX_HISTORY_PAGES) throw new HistoryError('消息历史过长，未能读到结束，不能证明会话没有本方消息');
    const nextCursor = typeof minMsgId === 'number' && minMsgId > 0 ? String(minMsgId) : String(Math.min(...mids.map(Number)));
    expected = { page: String(next), cursor: nextCursor };
    await loadOlder();
  }
}

export interface ChatSession {
  /** 选中目标已有会话并读取完整历史；不点击任何联系入口。 */
  enter(t: Target, id: ChatIdentity): Promise<void>;
  ownMessages(t: Target, id: ChatIdentity): Promise<number>;
  sendGreeting(t: Target, id: ChatIdentity, text: string): Promise<GreetingResult>;
}

export function createChatSession(browser: ChatBrowser, goto: (url: string) => Promise<void>): ChatSession {
  const observations = new Map<string, Observation>();

  const read = (t: Target, id: ChatIdentity) => browser.eval<PageState>(pageState(t, id));

  async function loadOlder(): Promise<void> {
    // 站点在内容不足一屏时自动加载下一页，否则要滚到顶部；等列表安静后滚动，两种情况都覆盖。
    await browser.waitFor(quiet('.chat-conversation .chat-record', QUIET_MS));
    await browser.eval(SCROLL_HISTORY_TOP);
  }

  async function enter(t: Target, id: ChatIdentity): Promise<void> {
    observations.delete(t.jobId);
    // 观察附着在当前标签页：先打开会话页，再开始观察，最后才选中目标触发首批历史请求。
    await goto(CHAT_URL);
    await browser.waitFor(`document.querySelectorAll(${js(LIST_ITEMS)}).length > 0`);
    if (await browser.eval<number>(markMatches(id)) !== 1) throw new Error('无法唯一识别已存在的目标会话，停止后续动作');
    const watch = await browser.watchResponses(HISTORY_ENDPOINT);
    try {
      await browser.clickSelector(`${LIST_ITEMS}[${TARGET_MARK}]`);
      await browser.waitFor(`(${pageState(t, id)}).identity`);
      const page = await read(t, id);
      if (page.uid === null || page.friendId === null) throw new Error('会话缺少账号或招聘者编号，不能核对消息归属');
      const account = { uid: page.uid, friendId: page.friendId };
      const historyOwn = await readHistory(watch, id, account, loadOlder);
      observations.set(t.jobId, { recruiterId: id.recruiterId, ...account, historyOwn, shown: new Set() });
    } finally {
      await watch.close();
    }
  }

  /** 当前页面仍显示同一会话且没有重新加载时返回本方消息数，否则返回 null。 */
  async function measure(t: Target, id: ChatIdentity): Promise<number | null> {
    const obs = observations.get(t.jobId);
    if (!obs || obs.recruiterId !== id.recruiterId) return null;
    const page = await read(t, id);
    const shown = new Set(page.items.map(item => item.mid));
    if (!page.identity || page.uid !== obs.uid || page.friendId !== obs.friendId || [...obs.shown].some(mid => !shown.has(mid))) return null;
    obs.shown = shown;
    const own = new Set(obs.historyOwn);
    for (const item of page.items) if (item.self) own.add(item.mid);
    return own.size;
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
    enter,
    ownMessages,

    async sendGreeting(t, id, text) {
      if (await ownMessages(t, id)) return { ok: true, skipped: true, evidence: '填写前已有本方消息，未发送本次招呼' };
      if (!(await browser.eval<boolean>(CONTROLS_READY))) return { ok: false, evidence: '会话页找不到唯一可见的输入框和发送按钮，未填写' };
      await browser.fillSelector(CHAT_INPUT, text);
      await browser.waitFor(quiet(CONTROLS, QUIET_MS));
      const own = await measure(t, id);
      if (own === null) return { ok: false, evidence: '填写后当前会话的岗位或招聘者身份已变化，未发送' };
      if (own) return { ok: true, skipped: true, evidence: '提交前出现本方消息，未发送本次招呼' };
      const input = await browser.eval<{ exact: boolean; sendable: boolean }>(inputState(text));
      if (!input.exact) return { ok: false, evidence: '输入框内容与批准原文不一致，未发送' };
      if (!input.sendable) return { ok: false, evidence: '发送按钮不可用，未发送' };
      const before = observations.get(t.jobId)!.shown;
      await browser.press('Enter');
      await browser.waitFor(echoed(t, id, text, before));
      return { ok: true, evidence: '招呼原文已作为本方新消息出现在目标会话中' };
    },
  };
}
