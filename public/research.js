import {$, text, el} from './dom.js';

const fitNames = {high:'匹配度高', medium:'匹配度中', low:'匹配度低'};

/** 方向调研：选城市开始/停止；勾选的方向只追加到本地具体要求草稿，由用户自行保存。 */
export function researchPanel({mutate, appendRequirements, updateControls}) {
 const chosen = new Set();
 let detailSeq = 0;
 let current = null;
 $('research-toggle').onclick = () => {
  if (current.research.status === 'running') return mutate('research/stop');
  mutate('research/start', 'POST', {city:$('research-city').value});
 };
 $('fill-requirements').onclick = () => {
  const picked = current.research.directions.filter(d => chosen.has(d.name));
  const line = `优先方向（${current.research.city ?? $('research-city').value}调研）：${picked.map(d => `${d.name}（关键词：${d.keywords.join('、')}）`).join('；')}`;
  appendRequirements(line);
  text('fill-status', `已填入 ${picked.length} 个方向，保存后生效`);
 };
 function directionCard(d) {
  const box = el('input', {type:'checkbox', checked:chosen.has(d.name)});
  box.addEventListener('change', () => { if (box.checked) chosen.add(d.name); else chosen.delete(d.name); text('fill-status', ''); updateControls(); });
  const ratio = d.sampled ? d.matched / d.sampled : 0;
  const meter = el('span', {className:'ratio'}, el('span'));
  meter.firstChild.style.transform = `scaleX(${ratio})`;
  return el('li', {className:`direction fit-${d.fit}`},
   el('div', {className:'direction-head'}, el('label', {className:'pick'}, box, d.name), el('span', {className:'badge', textContent:fitNames[d.fit]})),
   el('div', {className:'direction-stats'}, meter, el('span', {textContent:`抽样 ${d.sampled} · 匹配 ${d.matched}`}), d.salaryRange ? el('span', {className:'salary', textContent:d.salaryRange}) : null),
   detail(d));
 }
 /** 理由与短板默认折叠为约 3 行；只有内容实际超出时才出现「展开」。 */
 function detail(d) {
  const body = el('div', {className:'detail', id:`detail-${++detailSeq}`},
   el('p', {textContent:d.reason}),
   d.gaps ? el('p', {className:'gaps'}, el('strong', {textContent:'短板 '}), d.gaps) : null);
  const toggle = el('button', {type:'button', className:'quiet more', textContent:'展开', hidden:true});
  toggle.setAttribute('aria-controls', body.id);
  toggle.setAttribute('aria-expanded', 'false');
  toggle.onclick = () => {
   const open = toggle.getAttribute('aria-expanded') !== 'true';
   toggle.setAttribute('aria-expanded', String(open));
   toggle.textContent = open ? '收起' : '展开';
   body.classList.toggle('open', open);
  };
  return el('div', {}, body, toggle);
 }
 function measure() {
  for (const body of $('directions').querySelectorAll('.detail:not(.open)')) {
   const clipped = body.scrollHeight > body.clientHeight + 1;
   body.classList.toggle('clipped', clipped);
   body.nextSibling.hidden = !clipped;
  }
 }
 new ResizeObserver(measure).observe($('directions'));
 function render(state) {
  const research = state.research;
  current = state;
  const select = $('research-city');
  const cities = state.supportedCities.join('\n');
  if (select.dataset.cities !== cities) {
   const keep = select.value || research.city;
   select.replaceChildren(...state.supportedCities.map(city => el('option', {value:city, textContent:city})));
   select.dataset.cities = cities;
   if (state.supportedCities.includes(keep)) select.value = keep;
  }
  text('research-message', research.message ?? ({running:'正在调研…', stopping:'等待当前读取结束'}[research.status] ?? ''));
  $('research-activity').hidden = research.status === 'idle';
  const key = JSON.stringify(research.directions);
  if ($('directions').dataset.key === key) return;
  $('directions').dataset.key = key;
  const names = new Set(research.directions.map(d => d.name));
  for (const name of [...chosen]) if (!names.has(name)) chosen.delete(name);
  $('directions').replaceChildren(...research.directions.map(directionCard));
  measure();
  $('fill-row').hidden = !research.directions.length;
 }
 function controls(state, {pending, pendingAction, locked}) {
  if (!state) { $('research-toggle').disabled = true; return; }
  const status = state.research.status;
  text('research-toggle', pendingAction === 'research/start' ? '正在开始…' : pendingAction === 'research/stop' || status === 'stopping' ? '正在停止…' : status === 'running' ? '停止调研' : '开始调研');
  $('research-toggle').disabled = pending || status === 'stopping' || (status === 'idle' && (locked || !state.codex.signedIn || !state.resume.text.trim() || !$('research-city').value));
  $('research-city').disabled = status !== 'idle';
  $('fill-requirements').disabled = locked || chosen.size === 0;
 }
 return {render, controls};
}
