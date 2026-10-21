import {$, text, el} from './dom.js';
import {outcome, outcomeNames, keptTargets} from './outcome.js';

const batchNames = {draft:'草稿，尚未投递', approved:'待投递', running:'正在投递', paused:'已暂停', done:'已结束'};

/** 投递记录：只读列表；招呼语只在未确认/未发生行可展开核查。暂停或草稿时一个「继续投递」，带当前版本。 */
export function recordsPanel({mutate}) {
 let current = null;
 $('resume-batch').onclick = () => {
  const batch = current.batch;
  if (batch.status === 'running') return mutate('batch/pause');
  if (confirm('继续联系尚未处理的岗位并发送招呼原文？结果未确认的岗位不会重试。')) mutate('batch/start', 'POST', {version:batch.version});
 };
 function row(t) {
  const kind = outcome(t.steps);
  const needsCheck = kind === 'unknown' || kind === 'failed';
  return el('li', {className:`record ${kind}`},
   el('div', {className:'row-main'},
    el('span', {className:'row-title', textContent:`${t.company} · ${t.title}`}),
    el('span', {className:`state ${kind}`, textContent:outcomeNames[kind]})),
   kind === 'unknown' ? el('p', {className:'note', textContent:'请到 BOSS 核查是否已发出，不自动重试'}) : null,
   needsCheck ? el('details', {}, el('summary', {textContent:'查看招呼语'}),
    el('p', {className:'greeting', textContent:t.greeting}),
    t.evidence ? el('p', {className:'note', textContent:t.evidence}) : null) : null);
 }
 function render(state) {
  current = state;
  const batch = state.batch, kept = keptTargets(batch);
  $('records-empty').hidden = kept.length > 0;
  const key = JSON.stringify(kept.map(t => [t.id, t.steps, t.evidence, t.greeting]));
  if ($('records').dataset.key !== key) {
   $('records').dataset.key = key;
   $('records').replaceChildren(...kept.map(row));
  }
  if (!kept.length) { text('records-summary', ''); return; }
  const count = kind => kept.filter(t => outcome(t.steps) === kind).length;
  const parts = [batchNames[batch.status], `${kept.length} 个岗位`];
  for (const kind of ['done', 'skipped', 'unknown', 'failed']) if (count(kind)) parts.push(`${outcomeNames[kind]} ${count(kind)}`);
  if (batch.stopReason) parts.push(batch.stopReason);
  text('records-summary', parts.join(' · '));
 }
 function controls(state, {locked}) {
  const batch = state?.batch;
  const actionable = keptTargets(batch).some(t => outcome(t.steps) === 'todo');
  const resumable = batch && ['draft', 'approved', 'paused'].includes(batch.status) && actionable;
  const running = batch?.status === 'running';
  $('resume-batch').hidden = !resumable && !running;
  text('resume-batch', running ? '暂停投递' : '继续投递');
  $('resume-batch').disabled = running ? false : locked;
 }
 return {render, controls};
}
