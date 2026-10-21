import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { App } from '../src/app.ts';
import type { Site } from '../src/boss.ts';
import { tempDir } from './helpers.ts';
import { startMockModel, mockProviderToml } from './mock-responses.ts';

test('调研认证预检查期间已互斥，停止正常返回且不启动任何浏览器读取', async () => {
  const mock = await startMockModel([]);
  const dir = tempDir('boss-research-start-');
  fs.mkdirSync(path.join(dir, 'codex-home'));
  fs.writeFileSync(path.join(dir, 'codex-home', 'config.toml'), mockProviderToml(mock.baseUrl, 'gpt-mock'));
  const calls: string[] = [];
  const forbidden = async (): Promise<never> => { calls.push('action'); throw new Error('预检查停止后不应操作站点'); };
  const site: Site = {
    open: forbidden, close: async () => {}, status: async () => ({ page: 'ready', url: null }),
    search: forbidden, jobDetail: forbidden, openJob: forbidden, contact: forbidden, readChat: forbidden, sendGreeting: forbidden,
  };
  const app = new App({ dataDir: dir, site });
  try {
    app.saveInputs({ requirements: '', resume: { text: 'Python开发经验' } });
    app.startChat({ message: '调研北京方向' });
    assert.throws(() => app.startChat({ message: '建议？' }), { code: 'busy' });
    app.stopResearch();
    await new Promise<void>(resolve => { const check = () => void app.getState().then(s => { if (!s.chat.pending) { app.off('changed', check); resolve(); } }); app.on('changed', check); check(); });
    assert.equal((await app.getState()).research.status, 'idle');
    assert.deepEqual(calls, []);
    assert.equal(mock.requests.length, 0);
  } finally { await app.close(); mock.close(); }
});
