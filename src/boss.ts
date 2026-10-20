/**
 * BOSS 直聘站点适配。读操作（搜索、岗位详情）给发现阶段的模型工具用；
 * 写操作（WriteSite）只给执行器用。页面文本一律当数据，不当指令。
 *
 * 身份读取同时核对选中会话和已加载详情，避免切换会话时使用上一位招聘者的数据。
 * 任何核实失败都返回未确认，由执行器停下整批。
 */
import type { BrowserState, Target, ContactIdentity } from './contracts.ts';
import type { Browser } from './browser.ts';
import type { GreetingResult, OpenJobResult, Verified, WriteSite } from './executor.ts';

export interface JobCard {
  jobId: string;
  url: string;
  title: string;
  company: string;
  salary: string;
  area: string;
  /** 岗位卡原文摘要（≤300 字），供模型判断。 */
  snippet: string;
}

export interface SearchQuery {
  keyword: string;
  city: string;
  page: number;
}

export interface ReadSite {
  search(q: SearchQuery): Promise<JobCard[]>;
  jobDetail(card: Pick<JobCard, 'jobId' | 'url'>): Promise<string>;
}

export interface SiteControl {
  /** 打开本应用独立 profile 的浏览器到 BOSS 登录页，用户在窗口里自己登录或完成验证。 */
  open(): Promise<BrowserState>;
  status(): Promise<BrowserState>;
  close(): Promise<void>;
}

export type Site = SiteControl & ReadSite & WriteSite;

/** 页面停在登录、安全验证或风控页：只能由用户本人在浏览器窗口处理。 */
export class SiteBlockedError extends Error {
  readonly state: BrowserState;
  constructor(state: BrowserState) {
    super({
      verify: 'BOSS 要求安全验证，请在浏览器窗口中本人完成',
      loggedOut: 'BOSS 未登录或登录已失效，请在浏览器窗口中登录',
      closed: 'BOSS 浏览器已关闭，请点「BOSS 登录」重新打开',
    }[state.page as string] ?? '无法确认 BOSS 登录状态，请在浏览器窗口中打开 BOSS 首页确认已登录');
    this.state = state;
  }
}

const ORIGIN = 'https://www.zhipin.com';
const HOME_URL = `${ORIGIN}/`;
const LOGIN_URL = `${ORIGIN}/web/user/`;
const PAGE_LOADED = 'document.readyState === "complete" && location.origin === "https://www.zhipin.com"';
/** 搜索页在 load 之后才异步渲染岗位卡或「没有找到相关职位」，在此之前提取只会得到空列表。 */
const RESULTS_RENDERED = 'Boolean(document.querySelector(".job-card-box, .job-empty-box"))';

/** BOSS 内部查询使用的城市名称到代码映射，用于校验 AI 提取结果，不是 UI 固定选项列表。 */
const CITY_CODES: Record<string, string> = {
  全国: '100010000', 北京: '101010100', 上海: '101020100', 广州: '101280100', 深圳: '101280600', 杭州: '101210100',
  南京: '101190100', 苏州: '101190400', 成都: '101270100', 武汉: '101200100', 西安: '101110100', 重庆: '101040100',
  天津: '101030100', 长沙: '101250100', 郑州: '101180100', 厦门: '101230200',
};

export const SUPPORTED_CITIES = Object.keys(CITY_CODES);
export const MAX_SEARCH_PAGE = 5;

export function validateSearchQuery(q: SearchQuery): void {
  if (typeof q.keyword !== 'string' || !q.keyword.trim() || q.keyword.length > 80
    || !SUPPORTED_CITIES.includes(q.city) || !Number.isInteger(q.page) || q.page < 1 || q.page > MAX_SEARCH_PAGE) {
    throw new Error('搜索参数无效：需要有效的岗位词、支持的城市和页码');
  }
}

const PAGE_PROBE = `(() => {
  const visible = e => e.checkVisibility({checkVisibilityCSS:true,checkOpacity:true});
  return {
    url: location.href,
    title: document.title,
    hasAccount: [...document.querySelectorAll('.nav-figure, .user-nav .user-name')].some(visible),
    loginLink: [...document.querySelectorAll('a,button')].some(e => visible(e) && /^(登录|登录\\/注册)$/.test((e.textContent || '').trim())),
  };
})()`;

// 岗位卡薪资用站点私有字体显示数字：U+E031–U+E03A 依次对应 0–9。
const EXTRACT_CARDS = `(() => {
  const digits = (s) => s.replace(/[\\ue031-\\ue03a]/g, (c) => String(c.charCodeAt(0) - 0xe031));
  const seen = new Set(); const out = [];
  for (const a of document.querySelectorAll('a[href*="/job_detail/"]')) {
    const m = a.href.match(/\\/job_detail\\/([^/?#.]+)\\.html/);
    if (!m || seen.has(m[1]) || new URL(a.href).origin !== 'https://www.zhipin.com') continue;
    seen.add(m[1]);
    const card = a.closest('li') || a.parentElement;
    const q = (sel) => (card && card.querySelector(sel) && card.querySelector(sel).textContent || '').trim();
    out.push({
      jobId: m[1], url: a.href.split('?')[0],
      title: q('[class*="job-name"]') || (a.textContent || '').trim().split('\\n')[0],
      company: q('[class*="company-name"], [class*="boss-name"]'),
      salary: digits(q('[class*="salary"]')), area: q('[class*="job-area"], [class*="location"]'),
      snippet: digits((card && card.innerText) || '').replace(/\\s+/g, ' ').slice(0, 300),
    });
  }
  return out;
})()`;

const EXTRACT_DETAIL = `(document.querySelector('.job-sec-text')?.innerText || '').slice(0, 20000)`;

const OWN_MESSAGES = `[...document.querySelectorAll('.chat-conversation .message-list [class*="item-myself"]')].map((e) => (e.innerText || '').trim())`;

const CHAT_MESSAGES = `[...document.querySelectorAll('.chat-conversation .chat-record .item-myself')].map(e => (e.querySelector('.text-content')?.innerText || '').trim())`;
const CHAT_INPUT = '.chat-conversation .message-controls .chat-input[contenteditable="true"]';
// history/loading 初始也为 false；非空历史响应设置 isToTop/msgMinId 后，消息仍可能尚未合并。
// 首批清空旧列表，lastContentHeight 在合并后的 nextTick 设置；多页合并、零记录响应尚无可靠零消息证据。
const CHAT_MESSAGE_STATE = `(() => {
  const record = document.querySelector('.chat-conversation .chat-record')?.__vue__;
  const uid = window._PAGE?.uid;
  if (!record || !Array.isArray(record.list$) || uid == null) return {status:'unsupported'};
  if (record.loading === true) return {status:'loading'};
  if (record.loading !== false || record.boss?.friendId == null || record.boss.friendSource == null) return {status:'unsupported'};
  if (record.boss.encryptJobId !== record.selectedFriend$?.encryptJobId
    || record.boss.encryptBossId !== record.selectedFriend$?.encryptBossId) return {status:'identity'};
  const list = record.list$;
  const belongs = m => typeof m.isSelf === 'boolean' && m.isSelf === (m.fromId === uid)
    && m.friendSource === record.boss.friendSource
    && (m.isSelf ? m.toId === record.boss.friendId && m.fromId === uid : m.fromId === record.boss.friendId && m.toId === uid);
  if (!list.every(belongs)) return {status:'ownership'};
  const nodes = [...document.querySelectorAll('.chat-conversation .chat-record .im-list > .message-item')];
  const messages = new Map(list.map(m => [String(m.mid), m]));
  if (messages.size !== list.length || list.some(m => !m.mid)) return {status:'unsupported'};
  if (nodes.length !== list.length || nodes.some(e => {
    const m = messages.get(e.getAttribute('data-mid'));
    return !m || !e.classList.contains(m.isSelf ? 'item-myself' : 'item-friend');
  })) return {status:'rendering'};
  const own = nodes.filter(e => messages.get(e.getAttribute('data-mid')).isSelf);
  if (!own.length) {
    if (record.page !== 1 || !list.length || record.history !== false || record.isToTop !== true
      || !Number.isFinite(record.msgMinId) || record.msgMinId <= 0) return {status:'history'};
    if (!(record.lastContentHeight > 0) || record.lastContentHeight !== record.$refs?.scrollContent?.clientHeight) return {status:'rendering'};
  }
  return {status:'ready', messages:own.map(e => (e.querySelector('.text-content')?.innerText || '').trim())};
})()`;
const CHAT_READ_ERRORS = {
  unsupported: '当前消息读取结构不支持或账号依据缺失，不能当作空会话',
  loading: '当前会话消息尚未加载完成，停止发送',
  rendering: '当前会话消息尚未渲染一致，停止发送',
  identity: '消息历史请求的岗位或招聘者身份尚未同步，停止发送',
  ownership: '消息发送者、接收者与本方归属不一致，停止发送',
  history: '尚未取得完整历史证据，不能证明会话没有本方消息，停止发送',
} as const;
type ChatMessageState = { status: 'ready'; messages: string[] } | { status: keyof typeof CHAT_READ_ERRORS };

function identityUrl(href: string, kind: 'job_detail' | 'boss_detail'): string | null {
  try {
    const url = new URL(href);
    if (url.origin !== ORIGIN || !new RegExp('^/' + kind + '/[^/]+\\.html$').test(url.pathname)) return null;
    return url.origin + url.pathname;
  } catch {
    return null;
  }
}

function chatIdentityMatches(t: Target, expected: Extract<ContactIdentity, { kind: 'chatId' }>): string {
  return `(() => {
    const selected = document.querySelector('.chat-conversation')?.__vue__?.selectedFriend$;
    const header = document.querySelector('.chat-conversation .top-info-content')?.__vue__?.conversation$;
    const record = document.querySelector('.chat-conversation .chat-record')?.__vue__;
    const matches = value => value?.encryptJobId === ${JSON.stringify(expected.jobId)} && value?.encryptBossId === ${JSON.stringify(expected.recruiterId)};
    return matches(selected) && matches(header) && matches(record?.selectedFriend$) && matches(record?.conversation$)
      && header.companyName === ${JSON.stringify(t.company)};
  })()`;
}

export function createBossSite(browser: Browser): Site {
  let contactRef: string | null = null;
  const recipients = new Map<string, ContactIdentity>();

  async function status(): Promise<BrowserState> {
    if (!browser.isOpen) return { page: 'closed', url: null };
    const p = await browser.eval<{ url: string; title: string; loginLink: boolean; hasAccount: boolean }>(PAGE_PROBE).catch(() => null);
    if (!p) return { page: 'unknown', url: null };
    // 用户关掉窗口后 agent-browser 会自建空白页并弹出空白窗口：按已关闭处理并收起它。
    if (p.url === 'about:blank') {
      await browser.close();
      return { page: 'closed', url: null };
    }
    if (!p.url.startsWith(`${ORIGIN}/`)) return { page: 'unknown', url: p.url };
    if (/\/web\/passport\/zp\/(verify|security)/.test(p.url) || p.title.includes('安全验证')) return { page: 'verify', url: p.url };
    if (p.url.startsWith(LOGIN_URL) || p.loginLink) return { page: 'loggedOut', url: p.url };
    return { page: p.hasAccount ? 'ready' : 'unknown', url: p.url };
  }

  async function goto(url: string): Promise<void> {
    await browser.open(url);
    await browser.waitFor(PAGE_LOADED);
    const s = await status();
    if (s.page !== 'ready') throw new SiteBlockedError(s);
  }

  const findRef = (refs: Record<string, { role: string; name: string }>, test: (name: string, role: string) => boolean) =>
    Object.entries(refs).find(([, r]) => test(r.name.trim(), r.role))?.[0] ?? null;

  async function verifyChat(t: Target): Promise<void> {
    const s = await status();
    if (s.page !== 'ready' || !s.url?.includes('/web/geek/chat')) throw new Error('不在已登录的 BOSS 会话页');
    const expected = t.contactIdentity ?? recipients.get(t.jobId);
    if (!expected || expected.jobId !== t.jobId) throw new Error('缺少已核实的会话身份：该目标不能自动继续，请到 BOSS 核对并手动完成剩余步骤，不要重新联系');
    if (expected.kind === 'chatId') {
      const verified = await browser.eval<boolean>(chatIdentityMatches(t, expected));
      if (!verified) throw new Error('当前会话的岗位或招聘者身份不符：请在 BOSS 切回原目标会话，再点击继续；不要重新联系');
      return;
    }
    const identity = await browser.eval<{ company: string; hasHistory: boolean; job: string; recruiter: string }>(`(() => ({
      company: document.querySelector('.chat-conversation .company-name')?.textContent?.trim() || '',
      job: document.querySelector('.chat-conversation a[href*="/job_detail/"]')?.href || '',
      recruiter: document.querySelector('.chat-conversation a[href*="/boss_detail/"]')?.href || '',
      hasHistory: Boolean(document.querySelector('.chat-conversation .message-list'))
    }))()`);
    if (identity.company !== t.company || !identity.hasHistory
      || identityUrl(identity.job, 'job_detail') !== `${ORIGIN}/job_detail/${t.jobId}.html`
      || identityUrl(identity.recruiter, 'boss_detail') !== expected.recruiterUrl) {
      throw new Error('当前会话的岗位或招聘者身份不符：请在 BOSS 切回原目标会话，再点击继续；不要重新联系');
    }
  }

  function messageExpression(t: Target): string {
    return (t.contactIdentity ?? recipients.get(t.jobId))?.kind === 'chatId' ? CHAT_MESSAGES : OWN_MESSAGES;
  }

  async function ownMessages(t: Target): Promise<string[]> {
    await verifyChat(t);
    const expression = messageExpression(t);
    if (expression === CHAT_MESSAGES) {
      let read = await browser.eval<ChatMessageState>(CHAT_MESSAGE_STATE);
      if (read.status === 'loading' || read.status === 'rendering') {
        await browser.waitFor(`!['loading', 'rendering'].includes((${CHAT_MESSAGE_STATE}).status)`);
        read = await browser.eval<ChatMessageState>(CHAT_MESSAGE_STATE);
      }
      if (read.status !== 'ready') throw new Error(CHAT_READ_ERRORS[read.status]);
      await verifyChat(t);
      return read.messages;
    }
    const messages = await browser.eval<string[]>(expression);
    if (messages.length === 0) {
      const empty = await browser.eval<boolean>(`Boolean([...document.querySelectorAll('.chat-conversation .message-list *')].find(e => e.textContent?.trim() === '暂无聊天记录'))`);
      if (!empty) throw new Error('尚不能证明会话没有本方消息，停止发送');
    }
    await verifyChat(t);
    return messages;
  }

  async function jobIdentity(t: Target): Promise<ContactIdentity | null> {
    const redirects = await browser.eval<Array<{ origin: string; path: string; jobId: string | null; recruiterId: string | null } | null>>(`
      [...document.querySelectorAll('.btn-startchat[redirect-url]')].map(e => {
        try {
          const url = new URL(e.getAttribute('redirect-url'), location.href);
          return { origin: url.origin, path: url.pathname, jobId: url.searchParams.get('jobId'), recruiterId: url.searchParams.get('id') };
        } catch { return null; }
      })`);
    if (redirects.length) {
      // 招聘者 ID 是站点的不透明值（含 ~ 等字符），安全边界是来源与身份精确匹配，不是字符白名单。
      const ids = redirects.map(value => value?.origin === ORIGIN && value.path === '/web/geek/chat'
        && value.jobId === t.jobId && value.recruiterId ? value.recruiterId : null);
      if (!ids[0] || ids.some(id => id !== ids[0])) return null;
      return { kind: 'chatId', jobId: t.jobId, recruiterId: ids[0] };
    }
    const recruiterUrl = identityUrl(await browser.eval<string>(`document.querySelector('a[href*="/boss_detail/"]')?.href || ''`), 'boss_detail');
    return recruiterUrl ? { jobId: t.jobId, recruiterUrl } : null;
  }

  async function enterContactChat(t: Target, identity: ContactIdentity): Promise<void> {
    // agent-browser 已跟随点击产生的新标签页；站内弹层则不会改变岗位页 URL。
    await browser.waitFor('location.pathname.startsWith("/web/geek/chat") || Boolean(document.querySelector(".startchat-dialog")?.checkVisibility())');
    const current = await browser.eval<string>('location.pathname');
    if (!current.startsWith('/web/geek/chat')) {
      if (identity.kind !== 'chatId') throw new Error('聊天弹层缺少可核对的招聘者 ID，不能继续');
      await goto(`${ORIGIN}/web/geek/chat`);
      const matches = `[...document.querySelectorAll('.chat-user .chat-content li[role="listitem"]')].map((e, index) => ({ source: e.__vue__?.$props?.source, index })).filter(e => e.source?.encryptJobId === ${JSON.stringify(identity.jobId)} && e.source?.encryptBossId === ${JSON.stringify(identity.recruiterId)})`;
      await browser.waitFor(`(${matches}).length > 0`);
      const indices = await browser.eval<number[]>(`(${matches}).map(e => e.index)`);
      if (indices.length !== 1) throw new Error('无法唯一识别已存在的目标会话，停止后续动作');
      await browser.clickSelector(`.chat-user .chat-content li[role="listitem"]:nth-child(${indices[0]! + 1})`);
    }
    if (identity.kind === 'chatId') await browser.waitFor(chatIdentityMatches(t, identity));
    await verifyChat(t);
  }

  async function searchPage(q: SearchQuery): Promise<JobCard[]> {
    const params = new URLSearchParams({ query: q.keyword, city: CITY_CODES[q.city]! });
    await goto(`${ORIGIN}/web/geek/jobs?${params}`);
    await browser.waitFor(RESULTS_RENDERED);
    let cards = await browser.eval<JobCard[]>(EXTRACT_CARDS);
    let result = cards;
    // 站点忽略 URL 的 page 参数；每次滚到底部才请求下一批，页面保留已加载岗位。
    for (let page = 2; page <= q.page; page++) {
      if (!cards.length) return [];
      const more = await browser.eval<boolean | null>(`document.querySelector('.page-jobs-main')?.__vue__?.hasMore ?? null`);
      if (more === false) return [];
      if (more !== true) throw new Error('无法核实岗位列表的分页状态，停止搜索');
      const previous = new Set(cards.map(card => card.jobId));
      await browser.scrollToBottom();
      await browser.waitFor(`(() => {
        const pageState = document.querySelector('.page-jobs-main')?.__vue__;
        return pageState?.pageVo?.page >= ${page} && pageState.loading === false && pageState.moreLoading === false;
      })()`);
      cards = await browser.eval<JobCard[]>(EXTRACT_CARDS);
      result = cards.filter(card => !previous.has(card.jobId));
    }
    return result;
  }

  return {
    // 已登录账号访问登录页会在加载后再跳回首页，所以先看首页，只有未登录才进登录页。
    async open() {
      await browser.open(HOME_URL);
      await browser.waitFor(PAGE_LOADED);
      const s = await status();
      if (s.page !== 'loggedOut') return s;
      await browser.open(LOGIN_URL);
      return status();
    },
    status,
    close: () => browser.close(),

    async search(q) {
      validateSearchQuery(q);
      return searchPage(q);
    },

    async jobDetail(card) {
      await goto(card.url);
      return browser.eval<string>(EXTRACT_DETAIL);
    },

    async openJob(t: Target): Promise<OpenJobResult> {
      contactRef = null;
      recipients.delete(t.jobId);
      try {
        await goto(t.url);
      } catch (e) {
        if (e instanceof SiteBlockedError) return { kind: 'blocked', evidence: e.message };
        throw e;
      }
      const { refs } = await browser.snapshot();
      if (findRef(refs, (n) => n === '继续沟通')) return { kind: 'alreadyContacted', evidence: '岗位页显示「继续沟通」，站点上已有会话' };
      contactRef = findRef(refs, (n) => n === '立即沟通');
      if (!contactRef) return { kind: 'missing', evidence: '岗位页没有「立即沟通」入口（可能已下线）' };
      const recruiter = await jobIdentity(t);
      if (!recruiter) return { kind: 'blocked', evidence: '岗位页无法识别招聘者身份，未点击沟通' };
      recipients.set(t.jobId, recruiter);
      return { kind: 'canContact', evidence: '岗位页有「立即沟通」，已记录对应招聘者身份' };
    },

    async contact(t): Promise<Verified> {
      if (!contactRef) return { ok: false, evidence: '缺少「立即沟通」按钮引用' };
      const current = await browser.eval<string>('location.pathname');
      if (current !== `/job_detail/${t.jobId}.html`) return { ok: false, evidence: '当前岗位已变化，未点击沟通' };
      const recruiter = await jobIdentity(t);
      if (!recruiter || JSON.stringify(recruiter) !== JSON.stringify(recipients.get(t.jobId))) return { ok: false, evidence: '招聘者身份已变化，未点击沟通' };
      await browser.click(contactRef);
      contactRef = null;
      try {
        await enterContactChat(t, recruiter);
        return { ok: true, evidence: '已进入对应岗位和招聘者的会话页', identity: recipients.get(t.jobId)! };
      } catch (e) {
        return { ok: false, evidence: (e as Error).message };
      }
    },

    async readChat(t) {
      const mine = await ownMessages(t);
      return { ourMessages: mine.length, evidence: mine.length ? `会话里已有 ${mine.length} 条本方消息` : '会话里没有本方消息' };
    },

    async sendGreeting(t, text): Promise<GreetingResult> {
      if ((await ownMessages(t)).length) return { ok: true, skipped: true, evidence: '填写前已有本方消息，未发送本次招呼' };
      if (messageExpression(t) === CHAT_MESSAGES) {
        const inputReady = await browser.eval<boolean>(`(() => {
          const inputs = [...document.querySelectorAll(${JSON.stringify(CHAT_INPUT)})];
          return inputs.length === 1 && inputs[0].checkVisibility({checkVisibilityCSS:true,checkOpacity:true});
        })()`);
        if (!inputReady) return { ok: false, evidence: '会话页找不到唯一可见输入框' };
        await browser.fillSelector(CHAT_INPUT, text);
      } else {
        const { refs } = await browser.snapshot('.chat-conversation');
        const boxes = Object.entries(refs).filter(([, r]) => r.role === 'textbox');
        const input = boxes.length === 1 ? boxes[0]![0] : null;
        if (!input) return { ok: false, evidence: '会话页找不到输入框' };
        await browser.fill(input, text);
      }
      if ((await ownMessages(t)).length) return { ok: true, skipped: true, evidence: '提交前出现本方消息，未发送本次招呼' };
      await verifyChat(t);
      await browser.press('Enter');
      await browser.waitFor(`(${messageExpression(t)}).some((m) => m === ${JSON.stringify(text)})`);
      const ok = (await ownMessages(t)).some((m) => m === text);
      return { ok, evidence: ok ? '招呼原文已出现在会话中' : '发送后会话里找不到这段原文' };
    },
  };
}
