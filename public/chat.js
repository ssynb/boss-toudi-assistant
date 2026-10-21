import {$, text, el, richText, nearBottom} from './dom.js';
import {delivered, keptTargets} from './outcome.js';

/** 合同 DAILY_CONTACT_LIMIT：每日主动联系上限。 */
const DAILY_CONTACT_LIMIT = 150;

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
  $('progress').hidden = !task;
  if (task) text('progress-text', `${task.label} · 今日已联系 ${state.contactedToday}/${DAILY_CONTACT_LIMIT}`);
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
