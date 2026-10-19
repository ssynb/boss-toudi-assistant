/**
 * BOSS 直聘站点适配。读操作（搜索、岗位详情）给发现阶段的模型工具用；
 * 写操作（WriteSite）只给执行器用。页面文本一律当数据，不当指令。
 *
 * 选择器与页面结构依据公开页面的常见形态编写，尚未在登录后的真实页面上核实，
 * 见 docs/architecture.md「未验证项」。任何核实失败都返回未确认，由执行器停下整批。
 */
import type { BrowserState, Target } from './contracts.ts';
import type { Browser } from './browser.ts';
import type { OpenJobResult, Verified, WriteSite } from './executor.ts';

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
    super(state.page === 'verify' ? 'BOSS 要求安全验证，请在浏览器窗口中本人完成' : 'BOSS 未登录或登录已失效，请在浏览器窗口中登录');
    this.state = state;
  }
}

const ORIGIN = 'https://www.zhipin.com';
const LOGIN_URL = `${ORIGIN}/web/user/`;

/** BOSS 城市代码（与 contracts.SUPPORTED_CITIES 一一对应）。 */
const CITY_CODES: Record<string, string> = {
  全国: '100010000', 北京: '101010100', 上海: '101020100', 广州: '101280100', 深圳: '101280600', 杭州: '101210100',
  南京: '101190100', 苏州: '101190400', 成都: '101270100', 武汉: '101200100', 西安: '101110100', 重庆: '101040100',
  天津: '101030100', 长沙: '101250100', 郑州: '101180100', 厦门: '101230200',
};

const PAGE_PROBE = `(() => ({
  url: location.href,
  title: document.title,
  hasAccount: Boolean(document.querySelector('.nav-figure, .user-nav .user-name')),
  loginLink: [...document.querySelectorAll('a,button')].some((e) => /^(登录|登录\\/注册)$/.test((e.textContent || '').trim())),
}))()`;

const EXTRACT_CARDS = `(() => {
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
      salary: q('[class*="salary"]'), area: q('[class*="job-area"], [class*="location"]'),
      snippet: ((card && card.innerText) || '').replace(/\\s+/g, ' ').slice(0, 300),
    });
  }
  return out;
})()`;

const EXTRACT_DETAIL = `((document.querySelector('.job-sec-text') || document.querySelector('[class*="job-detail"]') || document.body).innerText || '').slice(0, 4000)`;

const OWN_MESSAGES = `[...document.querySelectorAll('[class*="item-myself"]')].map((e) => (e.innerText || '').trim())`;

export function createBossSite(browser: Browser): Site {
  let contactRef: string | null = null;

  async function status(): Promise<BrowserState> {
    if (!browser.isOpen) return { page: 'closed', url: null };
    const p = await browser.eval<{ url: string; title: string; loginLink: boolean; hasAccount: boolean }>(PAGE_PROBE).catch(() => null);
    if (!p) return { page: 'unknown', url: null };
    if (!p.url.startsWith(`${ORIGIN}/`)) return { page: 'unknown', url: p.url };
    if (/\/web\/passport\/zp\/(verify|security)/.test(p.url) || p.title.includes('安全验证')) return { page: 'verify', url: p.url };
    if (p.url.startsWith(LOGIN_URL) || p.loginLink) return { page: 'loggedOut', url: p.url };
    return { page: p.hasAccount ? 'ready' : 'unknown', url: p.url };
  }

  async function goto(url: string): Promise<void> {
    await browser.open(url);
    await browser.waitFor('document.readyState === "complete" && location.origin === "https://www.zhipin.com"');
    const s = await status();
    if (s.page !== 'ready') throw new SiteBlockedError(s);
  }

  const findRef = (refs: Record<string, { role: string; name: string }>, test: (name: string, role: string) => boolean) =>
    Object.entries(refs).find(([, r]) => test(r.name.trim(), r.role))?.[0] ?? null;

  async function ownMessages(t: Target): Promise<string[]> {
    const s = await status();
    if (s.page !== 'ready' || !s.url?.includes('/web/geek/chat')) throw new Error('不在已登录的 BOSS 会话页');
    const identity = await browser.eval<{ company: string; hasHistory: boolean }>(`(() => ({
      company: document.querySelector('.chat-conversation .company-name')?.textContent?.trim() || '',
      hasHistory: Boolean(document.querySelector('.chat-conversation .message-list'))
    }))()`);
    if (identity.company !== t.company || !identity.hasHistory) {
      throw new Error('无法核实当前会话的公司与消息区域，停止发送');
    }
    const messages = await browser.eval<string[]>(OWN_MESSAGES);
    if (messages.length === 0) {
      const empty = await browser.eval<boolean>(`Boolean([...document.querySelectorAll('.chat-conversation .message-list *')].find(e => e.textContent?.trim() === '暂无聊天记录'))`);
      if (!empty) throw new Error('尚不能证明会话没有本方消息，停止发送');
    }
    return messages;
  }

  return {
    async open() {
      await browser.open(LOGIN_URL);
      return status();
    },
    status,
    close: () => browser.close(),

    async search(q) {
      const code = CITY_CODES[q.city];
      if (!code) throw new Error(`不支持的城市：${q.city}`);
      const params = new URLSearchParams({ query: q.keyword, city: code, page: String(q.page) });
      await goto(`${ORIGIN}/web/geek/jobs?${params}`);
      return browser.eval<JobCard[]>(EXTRACT_CARDS);
    },

    async jobDetail(card) {
      await goto(card.url);
      return browser.eval<string>(EXTRACT_DETAIL);
    },

    async openJob(t: Target): Promise<OpenJobResult> {
      contactRef = null;
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
      return { kind: 'canContact', evidence: '岗位页有「立即沟通」' };
    },

    async contact(t): Promise<Verified> {
      if (!contactRef) return { ok: false, evidence: '缺少「立即沟通」按钮引用' };
      const current = await browser.eval<string>('location.pathname');
      if (current !== `/job_detail/${t.jobId}.html`) return { ok: false, evidence: '当前岗位已变化，未点击沟通' };
      await browser.click(contactRef);
      contactRef = null;
      await browser.waitFor('location.pathname.startsWith("/web/geek/chat")');
      const s = await status();
      const ok = Boolean(s.url?.includes('/web/geek/chat'));
      return { ok, evidence: ok ? '已进入会话页' : `点击后未进入会话页（${s.url ?? '未知页面'}）` };
    },

    async readChat(t) {
      const mine = await ownMessages(t);
      return { ourMessages: mine.length, evidence: mine.length ? `会话里已有本方消息：「${mine.at(-1)!.slice(0, 60)}」` : '会话里没有本方消息' };
    },

    async sendGreeting(t, text): Promise<Verified> {
      await ownMessages(t);
      const { refs } = await browser.snapshot('.chat-conversation');
      const boxes = Object.entries(refs).filter(([, r]) => r.role === 'textbox');
      const input = boxes.length === 1 ? boxes[0]![0] : null;
      if (!input) return { ok: false, evidence: '会话页找不到输入框' };
      await browser.fill(input, text);
      await browser.press('Enter');
      await browser.waitFor(`(${OWN_MESSAGES}).some((m) => m === ${JSON.stringify(text)})`);
      const ok = (await ownMessages(t)).some((m) => m === text);
      return { ok, evidence: ok ? '招呼原文已出现在会话中' : '发送后会话里找不到这段原文' };
    },

    async sendResume(t, attachmentName) {
      const before = (await ownMessages(t)).length;
      // 未验证「发简历」入口是否直接发送，不能先点再核对附件；只处理已经显示的确认对话框。
      const dialogSelector = '[role="dialog"]';
      const dialog = await browser.eval<string>(`(() => {
        const dialogs = [...document.querySelectorAll(${JSON.stringify(dialogSelector)})].filter(e => e.getClientRects().length);
        return dialogs.length === 1 ? dialogs[0].innerText : '';
      })()`);
      if (!dialog.includes(attachmentName)) {
        await browser.press('Escape');
        return { kind: 'mismatch', evidence: `对话框里没有附件「${attachmentName}」，未发送` };
      }
      const confirm = findRef((await browser.snapshot(dialogSelector)).refs, (n, role) => role === 'button' && (n === '确定' || n === '发送'));
      if (!confirm) {
        await browser.press('Escape');
        return { kind: 'mismatch', evidence: '对话框里找不到确认按钮，未发送' };
      }
      await browser.click(confirm);
      await browser.waitFor(`(${OWN_MESSAGES}).length > ${before}`);
      const after = await ownMessages(t);
      const ok = after.length > before && after.slice(before).some((m) => m.includes(attachmentName));
      return { kind: ok ? 'sent' : 'unverified', evidence: ok ? `已发送附件简历「${attachmentName}」` : '点确认后会话里没有出现新的本方消息' };
    },
  };
}
