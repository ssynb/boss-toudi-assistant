import {$, text, el} from './dom.js';

const stepNames = {todo:'未开始', inflight:'进行中', done:'已完成', skipped:'已跳过', failed:'未发生', unknown:'结果未确认 · 请到 BOSS 核查，不自动重试'};
const batchNames = {draft:'待确认投递', approved:'待投递', running:'正在执行', paused:'已暂停', done:'处理结束'};
const settled = steps => ['done', 'skipped'].includes(steps.greeting) && steps.contact !== 'unknown';
const outcome = steps => steps.contact === 'unknown' || steps.greeting === 'unknown' ? 'unknown'
 : steps.contact === 'failed' || steps.greeting === 'failed' ? 'failed' : settled(steps) ? 'done' : null;

/** 批次表格：保留招呼编辑与移除；结果芯片仅在状态变化时重建，以便入场动效标出新结果。 */
export function batchPanel({mutate, markDirty, dirty}) {
 function cell(row, className) { const td = el('td', {className}); row.append(td); return td; }
 function targetRow(target) {
  const row = el('tr', {id:`target-${target.id}`}); row.dataset.id = target.id;
  cell(row, 'job').append(el('strong'), el('span'));
  cell(row, 'salary'); cell(row, 'reason');
  const input = el('textarea', {name:'greeting', rows:3, maxLength:200}); input.setAttribute('aria-label', '招呼原文');
  cell(row, 'greeting').append(input);
  const remove = el('button', {type:'button', textContent:'移除', className:'quiet'});
  cell(row, 'action').append(remove, el('div', {className:'steps'}), el('p', {className:'evidence'}));
  const path = `batch/targets/${encodeURIComponent(target.id)}`;
  input.addEventListener('input', () => markDirty(row.id));
  input.addEventListener('change', () => mutate(path, 'PATCH', {greeting:input.value}, row));
  remove.onclick = () => mutate(path, 'PATCH', {removed:true}, row);
  return row;
 }
 function renderSteps(row, steps) {
  const key = `${steps.contact}/${steps.greeting}`;
  const box = row.querySelector('.steps');
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(
   el('span', {className:`step ${steps.contact}`, textContent:`会话：${stepNames[steps.contact]}`}),
   el('span', {className:`step ${steps.greeting}`, textContent:`招呼：${stepNames[steps.greeting]}`}));
 }
 function renderMeter(kept) {
  const count = kind => kept.filter(t => outcome(t.steps) === kind).length;
  for (const kind of ['done', 'unknown', 'failed'])
   $('batch-meter').querySelector(`.${kind}`).style.flexGrow = String(count(kind));
  $('batch-meter').style.setProperty('--rest', String(kept.length - count('done') - count('unknown') - count('failed')));
  return {done:count('done'), unknown:count('unknown'), failed:count('failed')};
 }
 return function render(state) {
  const batch = state.batch, kept = batch?.targets.filter(t => !t.removed) ?? [];
  $('batch').hidden = !kept.length; if (!kept.length) return;
  $('batch').dataset.status = batch.status;
  const tally = renderMeter(kept);
  const parts = [`${state.discovery.autoSend ? '自动投递 · ' : ''}${batchNames[batch.status]} · ${kept.length} 个岗位`];
  if (tally.done) parts.push(`已送达 ${tally.done}`);
  if (tally.unknown) parts.push(`未确认 ${tally.unknown}`);
  if (tally.failed) parts.push(`未发生 ${tally.failed}`);
  if (batch.stopReason) parts.push(batch.stopReason);
  text('batch-state', parts.join(' · '));
  const ids = new Set(kept.map(t => t.id));
  for (const row of [...$('targets').rows]) if (!ids.has(row.dataset.id)) { dirty.delete(row.id); row.remove(); }
  for (const target of kept) {
   const row = $(`target-${target.id}`) ?? $('targets').appendChild(targetRow(target));
   row.dataset.outcome = outcome(target.steps) ?? '';
   row.querySelector('strong').textContent = target.title;
   row.querySelector('.job span').textContent = target.company;
   row.querySelector('.salary').textContent = target.salary;
   row.querySelector('.reason').textContent = target.reason;
   if (!dirty.has(row.id)) row.querySelector('textarea').value = target.greeting;
   const started = target.steps.contact !== 'todo';
   row.querySelector('textarea').readOnly = started;
   row.querySelector('.action button').hidden = started;
   row.querySelector('.steps').hidden = !started;
   if (started) renderSteps(row, target.steps);
   row.querySelector('.evidence').textContent = started ? target.evidence : '';
  }
 };
}
