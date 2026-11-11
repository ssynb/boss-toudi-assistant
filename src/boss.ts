/**
 * BOSS 直聘站点适配。读操作（搜索、岗位详情）给发现阶段的模型工具用；
 * 写操作（WriteSite）只给执行器用。页面文本一律当数据，不当指令。
 *
 * 身份读取同时核对选中会话和已加载详情，避免切换会话时使用上一位招聘者的数据。
 * 任何核实失败都返回未确认，由执行器停下整批。
 */
import type { BrowserState, Target, ContactIdentity } from './contracts.ts';
import { BrowserHiddenError, BrowserWaitTimeoutError, type Browser } from './browser.ts';
import type { ResponseWatch } from './browser-responses.ts';
import type { GreetingResult, OpenJobResult, Verified, WriteSite } from './executor.ts';
import { createChatSession, domQuiet, HistoryError, OtherJobConversationError, ORIGIN, type ChatIdentity } from './boss-chat.ts';

export interface JobCard {
  jobId: string;
  url: string;
  title: string;
  company: string;
  salary: string;
  area: string;
  /** 岗位卡原文摘要（≤300 字），供模型判断。 */
  snippet: string;
  /** 卡片标签中与站点学历选项完全一致的一项；没有这类标签时缺省，不从其他文字推断。 */
  degree?: string;
  /** 站点把雇主显示为匿名公司（.is-anonymous）。 */
  anonymous?: boolean;
  /** 职位标识图标的文字（如「猎头」）。 */
  markers?: string[];
}

export interface SearchQuery {
  keyword: string;
  city: string;
  page: number;
}

export type RecommendQuery = Omit<SearchQuery, 'keyword'> & { tab?: string };

/**
 * 职位列表一批：cards 为本批新增岗位（可能因重复而为空）；exhausted 仅在本批加载完成后站点明确 hasMore=false 时为 true。
 * 加载失败直接抛错，不以空列表或 exhausted 表示未知。
 */
export type ListPage = { cards: JobCard[]; exhausted: boolean };

export interface ReadSite {
  /**
   * 职位页「推荐」标签在 city 下的第 page 批：1 打开页面（指定 tab 时切到该求职方向），之后在同一页面滚动加载。
   * 推荐随刷新变化，必须从 1 起连续调用，中途不能离开页面。城市参数不代替调用方逐卡核对 area。
   */
  recommend(q: RecommendQuery): Promise<ListPage>;
  search(q: SearchQuery): Promise<ListPage>;
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
    super(state.message ?? {
      verify: 'BOSS 要求安全验证，请在浏览器窗口中本人完成',
      restricted: 'BOSS 暂时限制访问，请勿频繁提交刷新请求；请等待站点恢复后再继续。',
      loggedOut: 'BOSS 未登录或登录已失效，请在浏览器窗口中登录',
      closed: 'BOSS 浏览器已关闭，请点「BOSS 登录」重新打开',
    }[state.page as string] ?? '无法确认 BOSS 登录状态，请在浏览器窗口中打开 BOSS 首页确认已登录');
    this.state = state;
  }
}

const HOME_URL = `${ORIGIN}/`;
/** 推荐与搜索同属职位页：不带 query 即「推荐」标签。/web/geek/recommend 是个人中心的沟通过列表，不是推荐流。 */
const JOBS_PATH = '/web/geek/jobs';
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
export const MAX_SEARCH_PAGE = 10;
const PAGE_SCROLL_ATTEMPTS = 3;
const PAGE_SCROLL_WAIT_MS = 6_000;
const HAS_MORE = `document.querySelector('.page-jobs-main')?.__vue__?.hasMore ?? null`;
/** 推荐标签的列表接口；切换求职方向时站点经防抖后才请求，只认点击之后发起的这次响应。 */
const RECOMMEND_LIST = `${ORIGIN}/wapi/zpgeek/pc/recommend/job/list.json`;
/** 列表数据已渲染：加载结束且卡片数不少于数据条数（Vue 渲染晚于数据更新）。 */
const LIST_RENDERED = `(() => {
  const state = document.querySelector('.page-jobs-main')?.__vue__;
  return Boolean(state) && state.loading === false && state.moreLoading === false && Array.isArray(state.jobList)
    && document.querySelectorAll('.job-card-box').length >= state.jobList.length;
})()`;

function validateRecommendQuery(q: RecommendQuery): void {
  if (!SUPPORTED_CITIES.includes(q.city) || !Number.isInteger(q.page) || q.page < 1) throw new Error('推荐参数无效：需要支持的城市和批次');
}

export function validateSearchQuery(q: SearchQuery): void {
  if (typeof q.keyword !== 'string' || !q.keyword.trim() || q.keyword.length > 80
    || !SUPPORTED_CITIES.includes(q.city) || !Number.isInteger(q.page) || q.page < 1 || q.page > MAX_SEARCH_PAGE) {
    throw new Error('搜索参数无效：需要有效的岗位词、支持的城市和页码');
  }
}

const PAGE_PROBE = `(() => {
  const visible = e => e.checkVisibility({checkVisibilityCSS:true,checkOpacity:true});
  const body = document.body?.innerText || '';
  const restricted = /^\\/web\\/passport\\/zp\\/403(?:\\.html)?(?:\\/|$)/.test(location.pathname)
    || /访问受限|被限制访问/.test(document.title + '\\n' + body);
  const restrictionText = restricted ? body.split(/[\\r\\n。！？]+/).map(s => s.trim())
    .filter(s => /访问受限|被限制访问|恢复/.test(s)).join('。') : '';

  return {
    url: location.href,
    title: document.title,
    restriction: restricted ? (restrictionText || 'BOSS 暂时限制访问') + '。请勿频繁提交刷新请求；请等待站点恢复后再继续。' : null,
    hasAccount: [...document.querySelectorAll('.nav-figure, .user-nav .user-name')].some(visible),
    loginLink: [...document.querySelectorAll('a,button')].some(e => {
      if (!visible(e)) return false;
      if (e.classList?.contains('header-login-btn')) return true;
      if (e.href) {
        const url = new URL(e.href, location.href);
        if (url.origin === ${JSON.stringify(ORIGIN)} && url.pathname === '/web/user/') return true;
      }
      return /^(登录|登录\\/注册)$/.test((e.innerText ?? e.textContent ?? '').trim().split(/\\r?\\n/, 1)[0].trim());
    }),
  };
})()`;

/** 账号区和登录入口会在 load 后异步出现；等待与状态探测共用相同信号。 */
const LOGIN_RENDERED = `(() => {
  const p = ${PAGE_PROBE};
  return /^\\/web\\/(user|passport)\\//.test(location.pathname) || p.title.includes('安全验证') || Boolean(p.restriction) || p.hasAccount || p.loginLink;
})()`;

const BLOCKED_PAGE = `(() => {
  const p = ${PAGE_PROBE};
  return /\\/web\\/passport\\/zp\\/(verify|security)/.test(new URL(p.url).pathname) || p.title.includes('安全验证')
    || Boolean(p.restriction) || new URL(p.url).pathname.startsWith('/web/user/') || p.loginLink;
})()`;

// 岗位卡薪资用站点私有字体显示数字：U+E031–U+E03A 依次对应 0–9。
// 学历、匿名和标识图标按 2026-11-05 真实职位页取证：.tag-list 独立学历标签、.is-anonymous、img.job-tag-icon[alt]。
const DEGREE_TAGS = ['学历不限', '初中及以下', '中专/中技', '高中', '大专', '本科', '硕士', '博士'];
const EXTRACT_CARDS = `(() => {
  const digits = (s) => s.replace(/[\\ue031-\\ue03a]/g, (c) => String(c.charCodeAt(0) - 0xe031));
  const degrees = ${JSON.stringify(DEGREE_TAGS)};
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
      degree: [...(card?.querySelectorAll('.tag-list li') ?? [])].map(e => e.textContent.trim()).find(t => degrees.includes(t)),
      anonymous: Boolean(card?.querySelector('.is-anonymous')),
      markers: [...(card?.querySelectorAll('img.job-tag-icon') ?? [])].map(e => (e.getAttribute('alt') || '').trim()).filter(Boolean),
    });
  }
  return out;
})()`;

const EXTRACT_DETAIL = `(document.querySelector('.job-sec-text')?.innerText || '').slice(0, 20000)`;

const CHAT_ENTRY = 'location.pathname.startsWith("/web/geek/chat") || Boolean(document.querySelector(".startchat-dialog")?.checkVisibility())';
const QUOTA_DIALOG = '.dialog-wrap.greet-pop';
const QUOTA_CONFIRM = `${QUOTA_DIALOG} .dialog-footer .btn-sure`;
const CONTACT_SETTLE_MS = 300;
const QUOTA_NOTICE = `(() => {
  const visible = e => e.checkVisibility({checkVisibilityCSS:true,checkOpacity:true});
  const dialogs = [...document.querySelectorAll(${JSON.stringify(QUOTA_DIALOG)})].filter(visible);
  if (dialogs.length !== 1) return null;
  const text = dialogs[0].innerText.replace(/\\s+/g, '');
  const match = text.match(/^温馨提示您今天已与(\\d+)位BOSS沟通[，,]还剩(\\d+)次沟通机会哦[！!。]?好$/);
  const buttons = [...dialogs[0].querySelectorAll('.dialog-footer .btn-sure')].filter(visible);
  if (!match || buttons.length !== 1 || buttons[0].textContent.trim() !== '好') return null;
  const used = Number(match[1]), remaining = Number(match[2]);
  return Number.isSafeInteger(used) && Number.isSafeInteger(remaining) ? {used,remaining} : null;
})()`;

function unchangedContactEntry(t: Target): string {
  return `(() => {
    const visible = e => e.checkVisibility({checkVisibilityCSS:true,checkOpacity:true});
    if (location.pathname !== ${JSON.stringify(`/job_detail/${t.jobId}.html`)} || document.querySelector('.page-chat-loading')
      || [...document.querySelectorAll('.dialog-wrap')].some(visible)) return false;
    const entries = [...document.querySelectorAll('.btn-startchat')].filter(visible);
    return entries.length === 1 && entries[0].innerText.trim() === '立即沟通'
      && entries[0].getAttribute('data-isfriend') !== 'true' && !entries[0].classList.contains('btn-disabled')
      && !entries[0].disabled && entries[0].getAttribute('aria-disabled') !== 'true';
  })()`;
}

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

export function createBossSite(browser: Browser, beforeJobOpen?: () => void): Site {
  /** 岗位页核实的招聘者身份；联系后在执行器写入目标前作为本次会话身份。 */
  const recipients = new Map<string, ContactIdentity>();

  async function inspectPage(): Promise<BrowserState> {
    if (!browser.isOpen) return { page: 'closed', url: null };
    const p = await browser.eval<{ url: string; title: string; loginLink: boolean; hasAccount: boolean; restriction: string | null }>(PAGE_PROBE).catch(() => null);
    if (!p) return { page: 'unknown', url: null };
    if (p.url === 'about:blank') return { page: 'closed', url: null };
    if (!p.url.startsWith(`${ORIGIN}/`)) return { page: 'unknown', url: p.url };
    if (p.restriction) return { page: 'restricted', url: p.url, message: p.restriction };
    if (/\/web\/passport\/zp\/(verify|security)/.test(p.url) || p.title.includes('安全验证')) return { page: 'verify', url: p.url };
    if (p.url.startsWith(LOGIN_URL) || p.loginLink) return { page: 'loggedOut', url: p.url };
    return { page: p.hasAccount ? 'ready' : 'unknown', url: p.url };
  }

  async function status(): Promise<BrowserState> {
    const current = await inspectPage();
    // 用户关窗后 CLI 可能自建空白页；主动探测状态时收起该空白窗口。
    if (current.page === 'closed' && browser.isOpen) await browser.close();
    return current;
  }

  async function waitPage(expression: string, step: string, timeoutMs?: number): Promise<BrowserState> {
    try { await browser.waitFor(`(${expression}) || (${BLOCKED_PAGE})`, step, timeoutMs); }
    catch (error) {
      const current = await status();
      if (['restricted', 'verify', 'loggedOut', 'closed'].includes(current.page)) throw new SiteBlockedError(current);
      throw error;
    }
    const current = await status();
    if (['restricted', 'verify', 'loggedOut', 'closed'].includes(current.page)) throw new SiteBlockedError(current);
    return current;
  }

  async function goto(url: string, beforeOpen?: () => void): Promise<void> {
    await chat.close();
    const current = await inspectPage();
    if (current.page === 'restricted') throw new SiteBlockedError(current);
    beforeOpen?.();
    await browser.open(url);
    await waitPage(PAGE_LOADED, '页面加载');
    const s = await waitPage(LOGIN_RENDERED, '登录标识');
    if (s.page !== 'ready') throw new SiteBlockedError(s);
  }

  const chat = createChatSession(browser, goto);
  /** 当前推荐页已返回的岗位，按岗位 ID 区分新增。 */
  let recommended = new Set<string>();
  let recommendPages = 0;
  let recommendTab: string | undefined;

  async function currentJobReady(t: Target): Promise<boolean> {
    if (!browser.isOpen) return false;
    const loaded = await browser.eval<boolean>(`(${PAGE_LOADED}) && location.pathname === ${JSON.stringify(`/job_detail/${t.jobId}.html`)}`);
    return loaded === true && (await status()).page === 'ready';
  }


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
    await browser.waitFor(`(${OWN_MESSAGES}).some((m) => m === ${JSON.stringify(text)})`, '旧会话发送回显');
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
    let quotaEvidence = '';
    try {
      // 新标签页由 agent-browser 跟随；路由与站内弹层都只作为「已点击生效」的信号，随后统一进入已有会话。
      await waitPage(`(${CHAT_ENTRY}) || Boolean(${QUOTA_NOTICE})`, '联系后会话入口或额度提示');
      const notice = await browser.eval<{used:number;remaining:number} | null>(QUOTA_NOTICE);
      if (notice) {
        quotaEvidence = `站点提示：今日已沟通 ${notice.used} 位 BOSS，剩余 ${notice.remaining} 次沟通机会；`;
        await browser.clickSelector(QUOTA_CONFIRM);
        await waitPage(`((${CHAT_ENTRY}) || (${unchangedContactEntry(t)})) && (${domQuiet('body', CONTACT_SETTLE_MS)})`, '额度提示关闭后会话入口');
        if (!(await browser.eval<boolean>(CHAT_ENTRY))) {
          const current = await status();
          const {refs: freshRefs} = await browser.snapshot();
          const unchanged = current.page === 'ready' && await browser.eval<boolean>(unchangedContactEntry(t))
            && contactRefs(freshRefs, '立即沟通').length === 1 && !contactRefs(freshRefs, '继续沟通').length
            && JSON.stringify(await jobIdentity(t)) === JSON.stringify(expected);
          if (unchanged) return {ok:false,notContacted:true,evidence:quotaEvidence+'提示已关闭，原岗位仍为「立即沟通」且未进入会话，已核实未发生联系；不再次点击'};
          return {ok:false,evidence:quotaEvidence+'关闭提示后未能核实会话或原联系入口，结果未确认'};
        }
      }
      if (expected.kind === 'chatId') await chat.enter(t, expected, true);
      else await verifyLegacyChat(t, expected);
      return { ok: true, evidence: quotaEvidence + '已进入对应岗位和招聘者的会话页', identity: expected };
    } catch (e) {
      if (e instanceof HistoryError) return { ok: true, evidence: `${quotaEvidence}已进入对应岗位和招聘者的会话页；${e.message}`, identity: expected };
      return { ok: false, evidence: quotaEvidence + (e as Error).message };
    }
  }

  /** 职位页（搜索与推荐）滚到底部才请求下一批；页面保留已加载岗位。 */
  async function loadNextPage(page: number): Promise<void> {
    const finished = `(() => {
      const state = document.querySelector('.page-jobs-main')?.__vue__;
      return state && (state.pageVo?.page >= ${page} || state.hasMore === false)
        && state.loading === false && state.moreLoading === false;
    })() && (${LIST_RENDERED})`;
    // 图片和详情渲染可能在首次滚动后增高页面。只读分页允许重新测量底部，最多等待 18 秒。
    for (let attempt = 1; attempt <= PAGE_SCROLL_ATTEMPTS; attempt++) {
      // 无法恢复可见时整轮停止，不当作单页失败重试或转去搜索。
      await browser.scrollToBottom().catch(error => {
        throw error instanceof BrowserHiddenError ? new SiteBlockedError({ page: 'unknown', url: null, message: error.message }) : error;
      });
      try {
        await waitPage(finished, `职位分页加载（第 ${page} 批，第 ${attempt} 次滚动）`, PAGE_SCROLL_WAIT_MS);
        return;
      } catch (error) {
        if (!(error instanceof BrowserWaitTimeoutError) || attempt === PAGE_SCROLL_ATTEMPTS) throw error;
      }
    }
  }

  /** 点击之后的第一页列表响应：须完整成功，给出岗位 ID 与是否还有更多。 */
  async function firstPageResponse(watch: ResponseWatch): Promise<{ ids: string[]; hasMore: boolean }> {
    for (;;) {
      const event = await watch.next();
      if (new URL(event.url).searchParams.get('page') !== '1') continue;
      const data = event.kind === 'response' && event.status === 200 ? (event.body as { code?: unknown; zpData?: { jobList?: unknown; hasMore?: unknown } } | null) : null;
      const jobs = data?.zpData?.jobList;
      if (data?.code !== 0 || !Array.isArray(jobs) || typeof data.zpData?.hasMore !== 'boolean' || jobs.some(job => typeof job?.encryptJobId !== 'string')) {
        throw new Error('求职方向推荐列表响应不完整，不能判断内容与是否还有更多');
      }
      return { ids: jobs.map(job => job.encryptJobId as string), hasMore: data.zpData.hasMore };
    }
  }

  async function recommendPage(q: RecommendQuery): Promise<ListPage> {
    const selected = `([...document.querySelectorAll('.c-expect-select .expect-item.active')].map(e => e.innerText.trim()).includes(${JSON.stringify(q.tab ?? '')}))`;
    const wrongTab = () => new SiteBlockedError({ page: 'unknown', url: null, message: `无法确认推荐标签「${q.tab}」，停止读取，不转搜索` });
    let exhausted: boolean;
    let only: Set<string> | null = null;
    if (q.page === 1) {
      recommended = new Set();
      recommendPages = 0;
      recommendTab = q.tab;
      await goto(`${ORIGIN}${JOBS_PATH}?${new URLSearchParams({ city: CITY_CODES[q.city]! })}`);
      await waitPage(RESULTS_RENDERED, '推荐结果渲染');
      if (q.tab) {
        const { refs } = await browser.snapshot();
        const matches = Object.entries(refs).filter(([, ref]) => ref.role === 'link' && ref.name === q.tab);
        if (matches.length !== 1) throw wrongTab();
        // 点击后标签立即显示选中，旧列表仍是加载完成状态；只认点击之后发起的列表请求及其渲染结果。
        const watch = await browser.watchResponses(RECOMMEND_LIST);
        try {
          await browser.click(matches[0]![0]);
          const list = await firstPageResponse(watch);
          const rendered = `${JSON.stringify(list.ids)}.every(id => document.querySelector('.job-card-box a[href*="/job_detail/' + id + '.html"]'))`;
          await waitPage(`(${selected}) && (${LIST_RENDERED}) && (${rendered})`, '求职方向推荐数据加载');
          only = new Set(list.ids);
          exhausted = !list.hasMore;
        } finally { await watch.close(); }
        if (!(await browser.eval<boolean>(selected))) throw wrongTab();
      } else {
        // 首屏只有确认是空结果才算用尽；其余情况由后续批次的分页状态判断。
        exhausted = await browser.eval<boolean>(`(${LIST_RENDERED}) && document.querySelector('.page-jobs-main').__vue__.hasMore === false && !document.querySelector('.job-card-box')`);
      }
    } else {
      // 重新打开会得到另一轮推荐，只能在原页面续读；某批失败时 recommendPages 不前进，可重试同一批。
      const at = await browser.eval<{ path: string; query: string | null }>(`({ path: location.pathname, query: new URLSearchParams(location.search).get('query') })`);
      if (q.tab !== recommendTab || q.tab && !(await browser.eval<boolean>(selected))) throw wrongTab();
      if (q.page !== recommendPages + 1 || at.path !== JOBS_PATH || at.query) throw new Error('推荐页已离开或批次不连续，不能续读推荐');
      if (!(await hasMorePages())) { recommendPages = q.page; return { cards: [], exhausted: true }; }
      await loadNextPage(q.page);
      exhausted = !(await hasMorePages());
    }
    const cards = (await browser.eval<JobCard[]>(EXTRACT_CARDS)).filter(card => !recommended.has(card.jobId) && (!only || only.has(card.jobId)));
    for (const card of cards) recommended.add(card.jobId);
    recommendPages = q.page;
    return { cards, exhausted };
  }

  /** 是否还有下一批；无法读取分页状态时停止，不把未知当作用尽。 */
  async function hasMorePages(): Promise<boolean> {
    const more = await browser.eval<boolean | null>(HAS_MORE);
    if (more === null) throw new Error('无法核实岗位列表的分页状态，停止读取');
    return more;
  }

  async function searchPage(q: SearchQuery): Promise<ListPage> {
    const params = new URLSearchParams({ query: q.keyword, city: CITY_CODES[q.city]! });
    await goto(`${ORIGIN}${JOBS_PATH}?${params}`);
    await waitPage(RESULTS_RENDERED, '搜索结果渲染');
    let cards = await browser.eval<JobCard[]>(EXTRACT_CARDS);
    // 首屏确认是空结果才算用尽；否则看本批加载完成后的分页状态。
    if (!cards.length) return { cards: [], exhausted: true };
    let result = cards;
    // 站点忽略 URL 的 page 参数；每次滚到底部才请求下一批，页面保留已加载岗位。
    for (let page = 2; page <= q.page; page++) {
      if (!(await hasMorePages())) return { cards: [], exhausted: true };
      const previous = new Set(cards.map(card => card.jobId));
      await loadNextPage(page);
      cards = await browser.eval<JobCard[]>(EXTRACT_CARDS);
      result = cards.filter(card => !previous.has(card.jobId));
    }
    return { cards: result, exhausted: !(await hasMorePages()) };
  }

  return {
    // 已登录账号访问登录页会在加载后再跳回首页，所以先看首页，只有未登录才进登录页。
    async open() {
      await chat.close();
      const current = await inspectPage();
      if (current.page === 'restricted') return current;
      await browser.open(HOME_URL);
      await browser.waitFor(`(${PAGE_LOADED}) || (${BLOCKED_PAGE})`, '页面加载');
      await browser.waitFor(LOGIN_RENDERED, '登录标识');
      const s = await status();
      if (s.page !== 'loggedOut') return s;
      await browser.open(LOGIN_URL);
      return status();
    },
    status,
    async close() { await chat.close(); await browser.close(); },

    async recommend(q) {
      validateRecommendQuery(q);
      return recommendPage(q);
    },

    async search(q) {
      validateSearchQuery(q);
      return searchPage(q);
    },

    async jobDetail(card) {
      await goto(card.url, beforeJobOpen);
      await waitPage(`Boolean(document.querySelector('.job-sec-text')?.innerText?.trim())`, 'JD详情');
      return browser.eval<string>(EXTRACT_DETAIL);
    },

    async openJob(t: Target): Promise<OpenJobResult> {
      recipients.delete(t.jobId);
      let hookFailed = false;
      try {
        await chat.close();
        if (!(await currentJobReady(t))) await goto(t.url, () => {
          try { beforeJobOpen?.(); }
          catch (error) { hookFailed = true; throw error; }
        });
      } catch (e) {
        if (!hookFailed && e instanceof SiteBlockedError) return { kind: 'blocked', evidence: e.message };
        throw e;
      }
      if (await browser.eval<string>('location.pathname') !== `/job_detail/${t.jobId}.html`) return { kind: 'blocked', evidence: '当前页面岗位与目标不符，未点击沟通' };
      const { refs } = await browser.snapshot();
      const existing = contactRefs(refs, '继续沟通').length;
      const immediate = contactRefs(refs, '立即沟通').length;
      if (existing + immediate > 1) return { kind: 'blocked', evidence: '岗位页沟通入口不唯一，未点击沟通' };
      if (existing === 1) return existingConversation(t);
      if (!immediate) return { kind: 'missing', evidence: '岗位页没有「立即沟通」入口（可能已下线）' };
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
