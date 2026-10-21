import {$, el, nearBottom} from './dom.js';

/** 求职顾问对话：发送后由服务端置 pending，回复经 SSE 刷新到达；本面板不触发任何投递动作。 */
export function chatPanel({mutate, updateControls}) {
 const send = async () => {
  const message = $('chat-input').value.trim();
  if (!message || $('chat-send').disabled) return;
  if (await mutate('chat', 'POST', {message})) $('chat-input').value = '';
 };
 $('chat-form').addEventListener('submit', event => { event.preventDefault(); void send(); });
 $('chat-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(); }
 });
 $('chat-input').addEventListener('input', updateControls);
 $('chat-clear').onclick = () => mutate('chat/clear');
 function render(state) {
  const log = $('chat-log');
  const follow = nearBottom(log);
  const {messages, pending} = state.chat;
  const key = `${messages.length}/${messages.at(-1)?.at ?? ''}/${pending}`;
  if (log.dataset.key === key) return;
  log.dataset.key = key;
  const items = messages.map(m => el('li', {className:`message ${m.role}`}, el('span', {className:'who', textContent:m.role === 'user' ? '我' : '顾问'}), el('p', {textContent:m.text})));
  if (pending) items.push(el('li', {className:'message assistant typing'}, el('span', {className:'who', textContent:'顾问'}), el('p', {textContent:'顾问正在回复…'})));
  if (!items.length) items.push(el('li', {className:'empty', textContent:'可以问方向选择、简历短板或招呼怎么写'}));
  log.replaceChildren(...items);
  $('chat-clear').hidden = !messages.length;
  if (follow) log.scrollTop = log.scrollHeight;
 }
 function controls(state, {locked}) {
  $('chat-send').disabled = locked || !$('chat-input').value.trim();
  $('chat-clear').disabled = locked;
 }
 return {render, controls};
}
