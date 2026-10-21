/** 岗位结果的唯一判定：只有招呼核实发出才算送达；skipped 可能是去重或已有本方消息，不能证明送达。 */
export function outcome(steps) {
 if (steps.contact === 'unknown' || steps.greeting === 'unknown') return 'unknown';
 if (steps.contact === 'failed' || steps.greeting === 'failed') return 'failed';
 if (steps.greeting === 'done') return 'done';
 if (steps.greeting === 'skipped' || steps.contact === 'skipped') return 'skipped';
 if (steps.contact === 'inflight' || steps.greeting === 'inflight') return 'inflight';
 return 'todo';
}
export const outcomeNames = {done:'已送达', skipped:'已跳过', unknown:'未确认', failed:'未发生', inflight:'进行中', todo:'待投递'};
export const keptTargets = batch => batch?.targets.filter(t => !t.removed) ?? [];
export const delivered = batch => keptTargets(batch).filter(t => outcome(t.steps) === 'done').length;
