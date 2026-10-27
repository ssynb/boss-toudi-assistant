import {$, text, el, richText, nearBottom} from './dom.js';
import {delivered, keptTargets} from './outcome.js';

/** 剩余浏览额度不足上限的这一比例时提示明天继续。 */
const READ_WARNING_RATIO = 0.1;

/** 当前运行中的任务（含等待 AI 决定）及其停止接口；对话是唯一开始入口，这里只提供停止。 */
function runningTask(state) {
 if (state.research.status !== 'idle') return {status:state.research.status, stop:'research/stop', label:`正在调研${state.research.city ? ` · ${state.research.city}` : ''} · 已完成 ${state.research.directions.length} 个方向`};
 if (state.discovery.status !== 'idle') return {status:state.discovery.status, stop:'discovery/stop', label:['正在找岗位', ...state.discovery.directions.map(d => `${d.name} ${d.selected}/${d.count}`)].join(' · ')};
 if (state.batch?.status === 'running') return {status:'running', stop:'batch/pause', label:`正在投递 · 已送达 ${delivered(state.batch)}/${keptTargets(state.batch).length}`};
 // AI 可能正决定开始调研或投递；服务端在对话等待期间的 discovery/stop 会中止这一回合。
 if (state.chat.pending) return {status:'running', stop:'discovery/stop', label:'AI 正在决定下一步'};
 return null;
}

/** 对话视图：消息列表只追加新消息（入场动效只给新消息），输入区上方显示运行中任务的进度与停止。 */
export function chatPanel({mutate, updateControls}) {
 let rendered = [];
 let task = null;
 const input = $('chat-input');
 const send = async () => {
  const message = input.value.trim();
  if (!message || $('chat-send').disabled) return;
  if (await mutate('chat', 'POST', {message})) { input.value = ''; resize(); }
 };
 const resize = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; };
 $('chat-form').addEventListener('submit', event => { event.preventDefault(); void send(); });
 input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(); }
 });
 input.addEventListener('input', () => { resize(); updateControls(); });
 for (const example of document.querySelectorAll('.examples button')) example.onclick = () => {
  input.value = example.textContent; resize(); input.focus(); updateControls();
 };
 $('chat-clear').onclick = () => mutate('chat/clear');
 $('progress-stop').onclick = () => { if (task) mutate(task.stop); };

 const messageNode = m => el('li', {className:`message ${m.role}`}, el('div', {className:'bubble'}, ...richText(m.text)));
 function renderMessages(messages) {
  const scroller = $('chat-scroller');
  const follow = nearBottom(scroller);
  const keys = messages.map(m => `${m.role}|${m.at}|${m.text.length}`);
  const appendOnly = rendered.length <= keys.length && rendered.every((key, i) => key === keys[i]);
  if (!appendOnly) $('chat-log').replaceChildren();
  for (const m of messages.slice(appendOnly ? rendered.length : 0)) {
   const node = messageNode(m); node.dataset.role = m.role; $('chat-log').append(node);
  }
  rendered = keys;
  if (follow) scroller.scrollTop = scroller.scrollHeight;
 }
 function render(state) {
  const {messages, pending} = state.chat;
  renderMessages(messages);
  $('chat-thinking').hidden = !pending;
  $('chat-empty').hidden = messages.length > 0 || pending;
  $('chat-clear').hidden = !messages.length;
  task = runningTask(state);
  const reads = `今日已浏览 ${state.jobReadsToday}/${state.dailyJobReadLimit}`;
  $('progress').hidden = !task;
  if (task) text('progress-text', `${task.label} · 今日已联系 ${state.contactedToday}/${state.dailyContactLimit} · ${reads}`);
  text('read-quota', reads);
  $('greeting-missing').hidden = Boolean(state.greeting);
  renderLimits(state);
 }
 /** 浏览额度接近或用尽、站点限制访问时的持久提示；限制访问只显示站点原文与等待说明，不给重试入口。 */
 function renderLimits(state) {
  const remaining = state.dailyJobReadLimit - state.jobReadsToday;
  const near = remaining <= state.dailyJobReadLimit * READ_WARNING_RATIO;
  $('read-limit').hidden = !near;
  if (near) text('read-limit', remaining > 0 ? `今日浏览快到上限，还能看 ${remaining} 个岗位；用完后请明天再继续` : '今日浏览已达上限，请明天再继续');
  const restricted = state.browser.page === 'restricted';
  $('restricted').hidden = !restricted;
  if (restricted) text('restricted-text', state.browser.message ?? 'BOSS 暂时限制访问。');
 }
 function controls(state, {pending, pendingAction, locked}) {
  $('chat-send').disabled = locked || !input.value.trim();
  $('chat-clear').disabled = locked;
  input.placeholder = task ? '任务进行中，可点「停止」' : '例如：Agent开发投30个';
  const stopping = task?.status === 'stopping' || (task && pendingAction === task.stop);
  text('progress-stop', stopping ? '正在停止…' : '停止');
  $('progress-stop').disabled = Boolean(stopping) || pending;
 }
 return {render, controls};
}
