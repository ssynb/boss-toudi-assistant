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
import { createChatSession, HistoryError, OtherJobConversationError, ORIGIN, type ChatIdentity } from './boss-chat.ts';

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

const HOME_URL = `${ORIGIN}/`;
const LOGIN_URL = `${ORIGIN}/web/user/`;
/** 账号区与登录入口在 load 之后才渲染（会话页约数百毫秒）；等到能判定登录状态再探测，避免把加载中当作未知。 */
const PAGE_LOADED = `document.readyState === "complete" && location.origin === "https://www.zhipin.com" && (() => {
  const visible = e => e.checkVisibility({checkVisibilityCSS:true,checkOpacity:true});
  return /^\\/web\\/(user|passport)\\//.test(location.pathname) || document.title.includes('安全验证')
    || [...document.querySelectorAll('.nav-figure, .user-nav .user-name')].some(visible)
    || [...document.querySelectorAll('a,button')].some(e => visible(e) && /^(登录|登录\\/注册)$/.test((e.textContent || '').trim()));
})()`;
/** 搜索页在 load 之后才异步渲染岗位卡或「没有找到相关职位」，在此之前提取只会得到空列表。 */
const RESULTS_RENDERED = 'Boolean(document.querySelector(".job-card-box, .job-empty-box"))';

/** BOSS 内部查询使用的城市名称到代码映射，用于校验 AI 提取结果，不是 UI 固定选项列表。 */
const CITY_CODES: Record<string, string> = {
  全国: '100010000', 北京: '101010100', 上海: '101020100', 广州: '101280100', 深圳: '101280600', 杭州: '101210100',
  南京: '101190100', 苏州: '101190400', 成都: '101270100', 武汉: '101200100', 西安: '101110100', 重庆: '101040100',
  天津: '101030100', 长沙: '101250100', 郑州: '101180100', 厦门: '101230200',
};

export const SUPPORTED_CITIES = Object.keys(CITY_CODES);
export const MAX_SEARCH_PAGE = 10;

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

function identityUrl(href: string, kind: 'job_detail' | 'boss_detail'): string | null {
  try {
    const url = new URL(href);
    if (url.origin !== ORIGIN || !new RegExp('^/' + kind + '/[^/]+\\.html$').test(url.pathname)) return null;
    return url.origin + url.pathname;
  } catch {
    return null;
  }
}

export function createBossSite(browser: Browser): Site {
  /** 岗位页核实的招聘者身份；联系后在执行器写入目标前作为本次会话身份。 */
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
    await chat.close();
    await browser.open(url);
    await browser.waitFor(PAGE_LOADED);
    const s = await status();
    if (s.page !== 'ready') throw new SiteBlockedError(s);
  }

  const chat = createChatSession(browser, goto);

  const contactRefs = (refs: Record<string, { role: string; name: string }>, name: string) =>
    Object.entries(refs).filter(([, r]) => r.name.trim() === name).map(([ref]) => ref);

  function savedIdentity(t: Target): ContactIdentity {
    const expected = t.contactIdentity ?? recipients.get(t.jobId);
    if (!expected || expected.jobId !== t.jobId) throw new Error('缺少已核实的会话身份：该目标不能自动继续，请到 BOSS 核对并手动完成剩余步骤，不要重新联系');
    return expected;
  }

  // 岗位页没有招聘者 ID 入口时的主页 URL 身份（含旧账本记录）沿用原核对：只在当前会话页核对，不自动进入。
  async function verifyLegacyChat(t: Target, expected: Exclude<ContactIdentity, ChatIdentity>): Promise<void> {
    const s = await status();
    if (s.page !== 'ready' || !s.url?.includes('/web/geek/chat')) throw new Error('不在已登录的 BOSS 会话页');
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

  async function legacyOwnMessages(t: Target, expected: Exclude<ContactIdentity, ChatIdentity>): Promise<string[]> {
    await verifyLegacyChat(t, expected);
    const messages = await browser.eval<string[]>(OWN_MESSAGES);
    if (messages.length === 0) {
      const empty = await browser.eval<boolean>(`Boolean([...document.querySelectorAll('.chat-conversation .message-list *')].find(e => e.textContent?.trim() === '暂无聊天记录'))`);
      if (!empty) throw new Error('尚不能证明会话没有本方消息，停止发送');
    }
    await verifyLegacyChat(t, expected);
    return messages;
  }

  async function legacyGreeting(t: Target, expected: Exclude<ContactIdentity, ChatIdentity>, text: string): Promise<GreetingResult> {
    if ((await legacyOwnMessages(t, expected)).length) return { ok: true, skipped: true, evidence: '填写前已有本方消息，未发送本次招呼' };
    const { refs } = await browser.snapshot('.chat-conversation');
    const boxes = Object.entries(refs).filter(([, r]) => r.role === 'textbox');
    const input = boxes.length === 1 ? boxes[0]![0] : null;
    if (!input) return { ok: false, evidence: '会话页找不到输入框' };
    await browser.fill(input, text);
    if ((await legacyOwnMessages(t, expected)).length) return { ok: true, skipped: true, evidence: '提交前出现本方消息，未发送本次招呼' };
    await verifyLegacyChat(t, expected);
    await browser.press('Enter');
    await browser.waitFor(`(${OWN_MESSAGES}).some((m) => m === ${JSON.stringify(text)})`);
    const ok = (await legacyOwnMessages(t, expected)).some((m) => m === text);
    return { ok, evidence: ok ? '招呼原文已出现在会话中' : '发送后会话里找不到这段原文' };
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

  /** 「继续沟通」只说明会话打开过：不点击，按真实 ID 只读进入，用完整历史区分已发送与仅打开。 */
  async function existingConversation(t: Target): Promise<OpenJobResult> {
    const recruiter = await jobIdentity(t);
    if (recruiter?.kind !== 'chatId') return { kind: 'blocked', evidence: '岗位页显示「继续沟通」但无法识别招聘者 ID，未进入会话' };
    try {
      const count = await chat.ownMessages(t, recruiter);
      if (count) return { kind: 'alreadyContacted', evidence: `已有会话里有 ${count} 条本方消息，不再发送` };
      return { kind: 'existingConversation', identity: recruiter, evidence: '岗位页显示「继续沟通」；完整历史证明本方尚无消息，未点击联系' };
    } catch (e) {
      if (e instanceof OtherJobConversationError) return { kind: 'alreadyContacted', evidence: e.message };
      return { kind: 'blocked', evidence: `已有会话无法完成只读核对：${(e as Error).message}` };
    }
  }

  /** 在已核实的岗位页上重新定位唯一的「立即沟通」并复核身份，点击后汇合到已有会话路径。 */
  async function contact(t: Target, expected: ContactIdentity): Promise<Verified> {
    if (await browser.eval<string>('location.pathname') !== `/job_detail/${t.jobId}.html`) return { ok: false, evidence: '当前岗位已变化，未点击沟通' };
    const { refs } = await browser.snapshot();
    const entries = contactRefs(refs, '立即沟通');
    if (entries.length !== 1 || contactRefs(refs, '继续沟通').length) return { ok: false, evidence: '岗位页的沟通入口已变化，未点击沟通' };
    const recruiter = await jobIdentity(t);
    if (JSON.stringify(recruiter) !== JSON.stringify(expected)) return { ok: false, evidence: '招聘者身份已变化，未点击沟通' };
    await browser.click(entries[0]!);
    try {
      // 新标签页由 agent-browser 跟随；路由与站内弹层都只作为「已点击生效」的信号，随后统一进入已有会话。
      await browser.waitFor('location.pathname.startsWith("/web/geek/chat") || Boolean(document.querySelector(".startchat-dialog")?.checkVisibility())');
      if (expected.kind === 'chatId') await chat.enter(t, expected);
      else await verifyLegacyChat(t, expected);
      return { ok: true, evidence: '已进入对应岗位和招聘者的会话页', identity: expected };
    } catch (e) {
      if (e instanceof HistoryError) return { ok: true, evidence: `已进入对应岗位和招聘者的会话页；${e.message}`, identity: expected };
      return { ok: false, evidence: (e as Error).message };
    }
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
      await chat.close();
      await browser.open(HOME_URL);
      await browser.waitFor(PAGE_LOADED);
      const s = await status();
      if (s.page !== 'loggedOut') return s;
      await browser.open(LOGIN_URL);
      return status();
    },
    status,
    async close() { await chat.close(); await browser.close(); },

    async search(q) {
      validateSearchQuery(q);
      return searchPage(q);
    },

    async jobDetail(card) {
      await goto(card.url);
      return browser.eval<string>(EXTRACT_DETAIL);
    },

    async openJob(t: Target): Promise<OpenJobResult> {
      recipients.delete(t.jobId);
      try {
        await goto(t.url);
      } catch (e) {
        if (e instanceof SiteBlockedError) return { kind: 'blocked', evidence: e.message };
        throw e;
      }
      const { refs } = await browser.snapshot();
      if (contactRefs(refs, '继续沟通').length) return existingConversation(t);
      if (!contactRefs(refs, '立即沟通').length) return { kind: 'missing', evidence: '岗位页没有「立即沟通」入口（可能已下线）' };
      const recruiter = await jobIdentity(t);
      if (!recruiter) return { kind: 'blocked', evidence: '岗位页无法识别招聘者身份，未点击沟通' };
      recipients.set(t.jobId, recruiter);
      return { kind: 'canContact', evidence: '岗位页有「立即沟通」，已记录对应招聘者身份' };
    },

    async contact(t): Promise<Verified> {
      const expected = recipients.get(t.jobId);
      if (!expected) return { ok: false, evidence: '缺少岗位页核实的招聘者身份，未点击沟通' };
      return contact(t, expected);
    },

    async readChat(t) {
      const expected = savedIdentity(t);
      const count = expected.kind === 'chatId' ? await chat.ownMessages(t, expected) : (await legacyOwnMessages(t, expected)).length;
      return { ourMessages: count, evidence: count ? `会话里已有 ${count} 条本方消息` : '完整历史与当前会话里都没有本方消息' };
    },

    async sendGreeting(t, text): Promise<GreetingResult> {
      const expected = savedIdentity(t);
      return expected.kind === 'chatId' ? chat.sendGreeting(t, expected, text) : legacyGreeting(t, expected, text);
    },
  };
}
