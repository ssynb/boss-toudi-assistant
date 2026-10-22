/**
 * 本地合成 BOSS 站点：岗位页、立即沟通（弹层/路由/新标签页）、会话列表、历史接口分页、
 * 输入框防抖与发送回显。只用于真实 CloakBrowser 测试，不连接 BOSS。
 */
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Browser } from '../src/browser.ts';
import { tempDir } from './helpers.ts';

export const UID = 7;
export const TARGET = { jobId: 'jobA', bossId: 'bossA', friendId: 8, company: '公司' };

export interface Friend { jobId: string; bossId: string; friendId: number; company: string }
export interface Message { mid: number; from: { uid: number }; to: { uid: number }; body: { text: string } }
export type HistoryReply = { status: number; body: unknown } | 'drop';

export interface Scenario {
  destination: 'popup' | 'route' | 'new-tab';
  /** 立即沟通对应的招聘者。 */
  target: Friend;
  /** 点击立即沟通后站点是否建立会话。 */
  createsFriend: boolean;
  continued?: boolean;
  windowSize?: number;
  hasMoreFriends?: boolean;
  friendPages?: Friend[][];
  newFriendDelay?: number;
  omitTargetRow?: boolean;
  /** 已有会话（不含尚未联系的目标）。 */
  friends: Friend[];
  pageSize: number;
  /** 改写某一页历史响应；返回 undefined 时用默认分页结果。 */
  history?: (query: { bossId: string; page: number; maxMsgId: string }, normal: HistoryReply) => HistoryReply | undefined | Promise<HistoryReply>;
  /** 页面请求第二页时使用错误游标。 */
  cursorGap?: boolean;
  /** 本方消息在历史渲染后/输入时到达（站点自动招呼竞态）。 */
  late?: 'after-history' | 'on-input';
  /** 输入时页面改动输入框（例如恢复草稿）。 */
  mangleInput?: boolean;
  /** 输入时页面切到另一会话。 */
  switchOnInput?: boolean;
  delivery?: 'delivered' | 'failed' | 'pending';
}

export interface BossFixture {
  origin: string;
  scenario: Scenario;
  contacts: number;
  sends: string[];
  history: Map<string, Message[]>;
  historyRequests: Array<{ bossId: string; page: number; maxMsgId: string }>;
  close(): Promise<void>;
}

const friendJson = (f: Friend) => ({ encryptJobId: f.jobId, encryptBossId: f.bossId, friendId: f.friendId, friendSource: 0, companyName: f.company });

export function message(mid: number, self: boolean, text: string, other = TARGET.friendId): Message {
  return { mid, from: { uid: self ? UID : other }, to: { uid: self ? other : UID }, body: { text } };
}

function jobPage(f: BossFixture, jobId: string): string {
  const { bossId } = f.scenario.target;
  const contacted = f.scenario.continued || f.scenario.friends.some(x => x.jobId === jobId && x.bossId === bossId);
  const redirect = `/web/geek/chat?id=${encodeURIComponent(bossId)}&jobId=${jobId}&securityId=SECRET-${jobId}`;
  const action = {
    popup: "document.querySelector('.startchat-dialog').hidden=false",
    route: `location.href=${JSON.stringify(redirect)}`,
    'new-tab': `window.open(${JSON.stringify(redirect)},'_blank')`,
  }[f.scenario.destination];
  return `<!doctype html><meta charset="utf-8"><title>岗位</title><div class="nav-figure">账号</div>
<div class="job-sec-text">岗位职责：本地合成 JD</div>
<a class="btn-startchat" href="javascript:;" redirect-url="${redirect}">${contacted ? '继续沟通' : '立即沟通'}</a>
<div class="startchat-dialog" hidden><textarea></textarea></div>
<script>document.querySelector('.btn-startchat').onclick=async()=>{await fetch('/wapi/contact?jobId=${jobId}',{method:'POST'});${action}};</script>`;
}

function chatPage(f: BossFixture): string {
  const s = f.scenario;
  return `<!doctype html><meta charset="utf-8"><title>聊天</title><div class="nav-figure">账号</div>
<style>.chat-message{height:200px;overflow:auto}.message-item{height:120px}</style>
<div class="chat-user"><div class="chat-content"><div class="user-list-content" style="height:240px;overflow:auto"><ul style="margin:0;padding:0"></ul></div></div></div>
<div class="chat-conversation"><div class="top-info-content"></div>
<div class="chat-record"><div class="chat-message"><div class="im-list"></div></div></div>
<div class="message-controls"><div class="chat-input" contenteditable="true" id="chat-input"></div><button class="btn-send disabled">发送</button></div></div>
<script>
window._PAGE={uid:${UID}};
const conv=document.querySelector(".chat-conversation"),header0=document.querySelector('.top-info-content'),record=document.querySelector('.chat-record');
const box=document.querySelector('.chat-message'),list=document.querySelector('.im-list'),input=document.getElementById('chat-input'),send=document.querySelector('.btn-send');
let friends=[],current=null,state=null,inputSeen=false;
function render(m,prepend){const self=m.from.uid===${UID};const e=document.createElement('div');e.className='message-item '+(self?'item-myself':'item-friend');e.dataset.mid=m.mid;e.innerHTML='<div class="text-content"></div>';e.firstChild.textContent=m.body.text;prepend?list.prepend(e):list.append(e);}
function select(f){current=f;const header={...f};conv.__vue__={selectedFriend$:f};header0.__vue__={conversation$:header};record.__vue__={selectedFriend$:f,conversation$:header};
  list.innerHTML='';state={page:1,min:0,hasMore:false,loading:false};load();}
async function load(){const f=current,st=state;st.loading=true;
  const cursor=${s.cursorGap ? 'st.page>1?st.min+1:st.min' : 'st.min'};
  const q=new URLSearchParams({bossId:f.encryptBossId,groupId:'',maxMsgId:String(cursor),c:'20',page:String(st.page),src:'0',securityId:'SECRET-'+f.encryptBossId,gid:''});
  let data;try{data=(await (await fetch('/wapi/zpchat/geek/historyMsg?'+q)).json()).zpData||{};}catch{st.loading=false;return;}
  if(f!==current)return;st.loading=false;const msgs=data.messages||[];if(!msgs.length)return;
  st.min=data.minMsgId||Math.min(...msgs.map(m=>m.mid));st.hasMore=data.hasMore;
  [...msgs].reverse().forEach(m=>render(m,st.page>1));if(st.page===1)box.scrollTop=box.scrollHeight;st.page++;
  ${s.late === 'after-history' ? "if(!window.lateDone){window.lateDone=true;addEventListener('fixture:late-message',()=>render({mid:9001,from:{uid:" + UID + "},to:{uid:f.friendId},body:{text:'站点默认招呼'}}),{once:true});}" : ''}
  if(st.hasMore&&box.scrollHeight<=box.clientHeight)load();}
box.addEventListener('scroll',()=>{if(box.scrollTop<=40&&state&&state.hasMore&&!state.loading)setTimeout(()=>{if(!state.loading)load();},200);});
let timer;new MutationObserver(()=>{clearTimeout(timer);timer=setTimeout(()=>send.classList.toggle('disabled',!input.innerText.trim()),100);}).observe(input,{childList:true,subtree:true,characterData:true});
input.addEventListener('input',()=>{if(inputSeen)return;inputSeen=true;
  ${s.late === 'on-input' ? "render({mid:9002,from:{uid:" + UID + "},to:{uid:current.friendId},body:{text:'站点默认招呼'}});" : ''}
  ${s.mangleInput ? "setTimeout(()=>input.append(' 草稿'),20);" : ''}
  ${s.switchOnInput ? "select(friends.find(x=>x!==current));" : ''}});
input.addEventListener('keydown',async e=>{if(e.key!=='Enter')return;e.preventDefault();if(send.classList.contains('disabled'))return;
  const text=input.innerText.trim();input.innerHTML='';const r=await (await fetch('/wapi/send?bossId='+encodeURIComponent(current.encryptBossId),{method:'POST',body:text})).json();
  render({mid:r.mid,from:{uid:${UID}},to:{uid:current.friendId},body:{text}});
  const status=document.createElement('i');status.className='message-status status-loading';list.lastChild.append(status);
  ${s.delivery === 'pending' ? '' : `queueMicrotask(()=>{status.className='message-status ${s.delivery === 'failed' ? 'status-error' : 'status-delivery'}';});`}
});
(async()=>{friends=await (await fetch('/wapi/friends')).json();const ul=document.querySelector('.chat-content ul');
  document.querySelector('.chat-user').__vue__={list$:friends,topList$:[],hasMore$:${Boolean(s.hasMoreFriends || s.friendPages?.length)}};
  const viewport=document.querySelector('.user-list-content'),windowSize=${s.windowSize ?? 10000};
  let renderedWindow='';
  function renderFriends(){const start=Math.min(Math.floor(viewport.scrollTop/60),Math.max(0,friends.length-windowSize));const key=start+':'+friends.length;if(key===renderedWindow)return;renderedWindow=key;ul.innerHTML='';
    ul.style.paddingTop=(start*60)+'px';ul.style.paddingBottom=(Math.max(0,friends.length-start-windowSize)*60)+'px';
    friends.slice(start,start+windowSize).forEach(f=>{${s.omitTargetRow ? `if(f.encryptJobId===${JSON.stringify(s.target.jobId)}&&f.encryptBossId===${JSON.stringify(s.target.bossId)})return;` : ''}const li=document.createElement('li');li.style.height='60px';li.setAttribute('role','listitem');li.textContent=f.companyName;li.__vue__={$props:{source:f}};li.onclick=()=>select(f);ul.append(li);});}
  let friendPage=0,friendLoading=false;
  async function moreFriends(){if(friendLoading||!document.querySelector('.chat-user').__vue__.hasMore$||viewport.scrollTop+viewport.clientHeight<viewport.scrollHeight-1)return;
    friendLoading=true;const r=await(await fetch('/wapi/friend-page?page='+friendPage++)).json();friends.push(...r.friends);document.querySelector('.chat-user').__vue__.hasMore$=r.hasMore;friendLoading=false;renderFriends();}
  renderFriends();viewport.addEventListener('scroll',()=>{renderFriends();moreFriends();});
  ${s.newFriendDelay ? `setTimeout(()=>{friends.push(${JSON.stringify(friendJson(s.target))});renderFriends();},${s.newFriendDelay});` : ''}
  const p=new URLSearchParams(location.search),auto=friends.find(f=>f.encryptBossId===p.get('id')&&f.encryptJobId===p.get('jobId'));if(auto)select(auto);})();
</script>`;
}

function historyReply(f: BossFixture, bossId: string, maxMsgId: string): HistoryReply {
  const all = [...(f.history.get(bossId) ?? [])].sort((a, b) => a.mid - b.mid);
  const older = maxMsgId === '0' ? all : all.filter(m => m.mid < Number(maxMsgId));
  const messages = older.slice(-f.scenario.pageSize);
  return { status: 200, body: { code: 0, zpData: { messages, hasMore: older.length > messages.length, minMsgId: messages[0]?.mid ?? 0 } } };
}

export async function startBoss(scenario: Partial<Scenario> = {}): Promise<BossFixture> {
  const f: BossFixture = {
    origin: '', contacts: 0, sends: [], history: new Map(), historyRequests: [],
    scenario: { destination: 'popup', target: TARGET, createsFriend: true, friends: [], pageSize: 20, ...scenario },
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://local');
    const html = (body: string) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
    const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const job = url.pathname.match(/^\/job_detail\/([^/]+)\.html$/);
    if (job) return html(jobPage(f, job[1]!));
    if (url.pathname === '/web/geek/chat') return html(chatPage(f));
    if (url.pathname === '/wapi/friends') return json(200, f.scenario.friends.filter(x => !f.scenario.newFriendDelay || x.jobId !== f.scenario.target.jobId).map(friendJson));
    if (url.pathname === '/wapi/friend-page') {
      const page = Number(url.searchParams.get('page'));
      const pages = f.scenario.friendPages ?? [];
      return json(200, {friends:(pages[page] ?? []).map(friendJson),hasMore:page+1<pages.length});
    }
    if (url.pathname === '/wapi/contact') {
      f.contacts++;
      const { target, friends, createsFriend } = f.scenario;
      const jobId = url.searchParams.get('jobId')!;
      if (createsFriend && !friends.some(x => x.jobId === jobId && x.bossId === target.bossId)) friends.unshift({ ...target, jobId });
      return json(200, { code: 0 });
    }
    if (url.pathname === '/wapi/send') {
      let text = '';
      req.on('data', c => { text += c; });
      req.on('end', () => {
        const bossId = url.searchParams.get('bossId')!;
        const friend = f.scenario.friends.find(x => x.bossId === bossId)!;
        const mid = 10_000 + f.sends.length;
        f.sends.push(text);
        f.history.set(bossId, [...(f.history.get(bossId) ?? []), message(mid, true, text, friend.friendId)]);
        json(200, { mid });
      });
      return;
    }
    if (url.pathname === '/wapi/zpchat/geek/historyMsg') {
      const query = { bossId: url.searchParams.get('bossId')!, page: Number(url.searchParams.get('page')), maxMsgId: url.searchParams.get('maxMsgId')! };
      f.historyRequests.push(query);
      const normal = historyReply(f, query.bossId, query.maxMsgId);
      const reply = f.scenario.history?.(query, normal) ?? normal;
      void Promise.resolve(reply).then(value => {
        if (value === 'drop') req.socket.destroy();
        else json(value.status, value.body);
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  f.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return f;
}

export function localBrowser(name: string): Browser {
  return new Browser({ profileDir: path.join(tempDir(`boss-${name}-`), 'profile'), headed: false, namespace: `${name}-${process.pid}` });
}

const BOSS_ORIGIN = 'https://www.zhipin.com';

/**
 * Browser 边界替身：只把 BOSS 来源与本地来源互相映射（导航、页面脚本、结果、响应观察），
 * CDP 响应、DOM、点击、填写和生产身份判定都由真实 CloakBrowser 执行。
 */
export function bossBrowser(browser: Browser, f: BossFixture): Browser {
  const toLocal = (text: string) => text.replaceAll(BOSS_ORIGIN, f.origin);
  const toBoss = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value).replaceAll(f.origin, BOSS_ORIGIN));
  return new Proxy(browser, {
    get(object, key) {
      if (key === 'open') return (url: string) => object.open(toLocal(url));
      if (key === 'eval') return async (expression: string) => toBoss(await object.eval(toLocal(expression)));
      if (key === 'waitFor') return (expression: string, step?: string, timeoutMs?: number) => object.waitFor(toLocal(expression), step, timeoutMs);
      if (key === 'watchResponses') return async (endpoint: string) => {
        const watch = await object.watchResponses(toLocal(endpoint));
        return { get revision() { return watch.revision; }, next: async () => toBoss(await watch.next()), close: () => watch.close() };
      };
      const value = Reflect.get(object, key, object);
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
}

export const draft = (greeting = '定制招呼') => ({
  jobId: TARGET.jobId, company: TARGET.company, title: '岗位', salary: '', url: `${BOSS_ORIGIN}/job_detail/${TARGET.jobId}.html`, reason: '', greeting,
});
