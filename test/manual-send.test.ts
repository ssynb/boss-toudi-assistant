import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openState } from '../src/state.ts';
import { startServer } from '../src/server.ts';
import type { Site } from '../src/boss.ts';
import type { AppState, ApiError } from '../src/contracts.ts';
import { api, tempDir } from './helpers.ts';

for (const previousUnknown of [false, true]) {
  test(`一次确认即投递且拒绝旧版本；保留未知联系=${previousUnknown}`, async () => {
    const dataDir = tempDir('boss-manual-send-');
    const state = openState(path.join(dataDir, 'state.sqlite'));
    const drafts = ['a', 'b'].map(jobId => ({ jobId, url: `https://www.zhipin.com/job_detail/${jobId}.html`, title: '前端', company: '公司', salary: '20-30K', reason: '匹配', greeting: '你好' }));
    const batch = state.replaceBatch(drafts);
    if (previousUnknown) state.setStep(batch.targets[0]!, 'contact', 'unknown', '此前点击结果未确认');
    state.close();
    const contacts: string[] = [];
    const site: Site = {
      open: async () => ({ page: 'ready', url: null }), status: async () => ({ page: 'ready', url: null }), close: async () => {},
      search: async () => [], jobDetail: async () => '',
      openJob: async () => ({ kind: 'canContact', evidence: '' }),
      contact: async target => { contacts.push(target.jobId); return { ok: true, evidence: '合成会话已打开' }; },
      readChat: async () => ({ ourMessages: 1, evidence: '已有招呼' }),
      sendGreeting: async () => { throw new Error('已有本方消息不能重发'); },
    };
    const server = await startServer({ dataDir, port: 0, site });
    try {
      const stale = await api<ApiError>(server.url, 'POST', '/api/batch/start', { version: batch.version - 1 });
      assert.equal(stale.json.error.code, 'stale_version');
      assert.deepEqual(contacts, []);
      assert.equal((await server.app.getState()).batch!.status, 'draft');
      const started = await api<AppState>(server.url, 'POST', '/api/batch/start', { version: batch.version });
      assert.equal(started.status, 200, JSON.stringify(started.json));
      const finished = await new Promise<AppState>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); server.app.off('changed', check); };
        const check = () => void server.app.getState().then(next => {
          if (next.batch?.status !== 'running') { cleanup(); resolve(next); }
        }, error => { cleanup(); reject(error); });
        const timer = setTimeout(() => { cleanup(); reject(new Error('投递未结束')); }, 5000);
        server.app.on('changed', check);
        check();
      });
      assert.equal(finished.batch!.status, 'done');
      assert.deepEqual(contacts, previousUnknown ? ['b'] : ['a', 'b']);
      if (previousUnknown) assert.equal(finished.batch!.targets[0]!.steps.contact, 'unknown');
    } finally { await server.close(); }
  });
}
