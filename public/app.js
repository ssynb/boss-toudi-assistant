import {request, events} from './client.js';
import {$, text} from './dom.js';
import {chatPanel} from './chat.js';
import {profilePanel} from './profile.js';
import {recordsPanel} from './records.js';

let state = null, pending = false, sequence = 0, pendingAction = null;
const dirty = new Set();
const fail = error => { text('error', error.message); $('error').hidden = false; };

async function mutate(path, method = 'POST', body) {
 if (pending) return false;
 pending = true; pendingAction = path; controls(); $('error').hidden = true;
 try {
  const next = await request(`/api/${path}`, method, typeof body === 'function' ? await body() : body);
  sequence++; render(next);
  return true;
 } catch (error) { fail(error); return false; } finally { pending = false; pendingAction = null; controls(); }
}
const updateControls = () => controls();
const panels = [chatPanel({mutate, updateControls}), profilePanel({mutate, dirty, updateControls}), recordsPanel({mutate})];

/** 发现、调研、对话、批次执行互斥：任一进行中时锁定发消息、保存资料、清空对话与继续投递。 */
function busy() {
 return pending || !state || state.discovery.status !== 'idle' || state.research.status !== 'idle' || state.batch?.status === 'running' || state.chat.pending;
}
function controls() {
 for (const button of document.querySelectorAll('[data-action]')) button.disabled = pending || !state;
 if (!state) return;
 for (const panel of panels) panel.controls(state, {pending, pendingAction, locked:busy()});
}
const pageNames = {closed:'BOSS 登录', unknown:'BOSS · 状态未知', loggedOut:'BOSS 登录', verify:'BOSS · 请完成验证', ready:'BOSS · 已登录'};
function render(next) {
 state = next;
 text('codex', state.codex.signedIn ? `Codex · ${state.codex.email ?? '已登录'}` : 'Codex 登录');
 $('codex').dataset.ok = String(state.codex.signedIn);
 $('codex').hidden = Boolean(state.codex.pendingLoginUrl);
 if (state.codex.error) fail(new Error(state.codex.error));
 const url = state.codex.pendingLoginUrl;
 $('login').hidden = !url;
 if (url) { if (new URL(url).protocol === 'https:') $('login').href = url; else $('login').removeAttribute('href'); }
 text('browser', pageNames[state.browser.page]);
 $('browser').dataset.ok = String(state.browser.page === 'ready');
 for (const panel of panels) panel.render(state);
 controls();
}
async function refresh() {
 const ticket = ++sequence;
 try { const next = await request('/api/state'); if (ticket === sequence && !pending) render(next); } catch (error) { fail(error); }
}

const views = {chat:'对话', profile:'个人信息', records:'投递记录'};
function route() {
 const view = views[location.hash.slice(1)] ? location.hash.slice(1) : 'chat';
 for (const name of Object.keys(views)) $(`view-${name}`).hidden = name !== view;
 for (const link of document.querySelectorAll('[data-view]')) {
  if (link.dataset.view === view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
 }
 document.title = `${views[view]} · boss 投递助手`;
 if (view === 'chat') $('chat-scroller').scrollTop = $('chat-scroller').scrollHeight;
}
window.addEventListener('hashchange', route);
route();

for (const button of document.querySelectorAll('[data-action]')) button.onclick = () => mutate(button.dataset.action);
window.addEventListener('focus', () => { if (!pending) void refresh(); });
window.addEventListener('beforeunload', event => { if (dirty.size) { event.preventDefault(); event.returnValue = ''; } });
controls();
await refresh();
events(name => { if (name === 'changed') refresh(); })
 .then(() => fail(new Error('实时连接已断开。请重新加载页面恢复实时进度。'))).catch(fail);
