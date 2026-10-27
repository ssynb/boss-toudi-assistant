import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CodexClient } from '../src/codex.ts';
import { askAdvisor } from '../src/advisor.ts';
import { openState } from '../src/state.ts';
import { tempDir } from './helpers.ts';
import { mockProviderToml, startMockModel } from './mock-responses.ts';

for (const size of [4, 150]) test(`顾问收到真实账本与批次概况，当前批次${size}项`, async () => {
  const mock = await startMockModel([
    [{ type: 'function_call', name: 'reply', args: { text: '账本已有记录，不能将缺少完整历史名单理解为没有投递。' } }],
    [{ type: 'message', text: '完成' }],
  ]);
  const dir = tempDir('boss-advisor-delivery-');
  for (const name of ['codex-home', 'home', 'work']) fs.mkdirSync(path.join(dir, name));
  fs.writeFileSync(path.join(dir, 'codex-home', 'config.toml'), mockProviderToml(mock.baseUrl, 'gpt-mock'));
  const codex = new CodexClient({ codexHome: path.join(dir, 'codex-home'), userHome: path.join(dir, 'home'), workDir: path.join(dir, 'work') });
  const state = openState(path.join(dir, 'state.sqlite'));
  try {
    state.saveInputs({ greeting: '您好，我有五年 React 经验', requirements: '深圳AI开发', resume: { text: 'Python与Agent经验' } });
    const drafts = Array.from({ length: 150 }, (_, i) => ({ jobId: `j${i}`, company: `公司${i}`, title: 'AI工程师', salary: '20-40K', url: `https://www.zhipin.com/job_detail/j${i}.html`, reason: '匹配', greeting: '你好' }));
    const history = state.replaceBatch(drafts);
    for (const target of history.targets) state.setStep(target, 'contact', 'done', '历史记录');
    const batch = state.replaceBatch(drafts.slice(0, size));
    state.approve(batch.version);
    state.beginRun();
    for (const [i, target] of batch.targets.entries()) {
      state.setStep(target, 'contact', i === 1 ? 'unknown' : i === 2 ? 'skipped' : 'done', '合成测试证据');
      if (i !== 1 && i !== 2 && i !== 3) state.setStep(target, 'greeting', 'done', '已送达');
    }
    state.finishRun('paused', '测试暂停');
    await askAdvisor(codex, new AbortController().signal, state.snapshot());
    const user = mock.requests[0]!.input.filter(item => (item as { role?: string }).role === 'user').at(-1) as { content: { text: string }[] };
    const delivery = JSON.parse(user.content[0]!.text).delivery;
    assert.ok(delivery, '顾问不能在缺少账本概况时臆断没有已投递记录');
    assert.equal(delivery.contactedCount, 150);
    assert.equal(delivery.currentBatch.status, 'paused');
    assert.equal(delivery.currentBatch.total, size);
    assert.deepEqual(delivery.currentBatch.steps.contact, { done: size - 2, unknown: 1, skipped: 1 });
    assert.deepEqual(delivery.currentBatch.steps.greeting, { done: size - 3, todo: 3 });
    assert.equal(delivery.currentBatch.deliveredCompaniesTotal, size - 3);
    assert.ok(delivery.currentBatch.deliveredCompanies.includes('公司0'));
    for (const company of ['公司1', '公司2', '公司3']) assert.ok(!delivery.currentBatch.deliveredCompanies.includes(company), '未知/跳过/仅联系不算招呼已送达');
    if (size === 150) {
      assert.ok(delivery.currentBatch.deliveredCompanies.length < 147, '长公司名单须有界');
      assert.equal(delivery.currentBatch.deliveredCompaniesTruncated, true);
    } else assert.equal(delivery.currentBatch.deliveredCompaniesTruncated, false);
    assert.match(delivery.scope, /当前批次/);
    assert.match(delivery.scope, /未确认/);
  } finally { codex.close(); state.close(); mock.close(); }
});
