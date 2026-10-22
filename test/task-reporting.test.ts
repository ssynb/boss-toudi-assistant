import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/server.ts';
import type { Site } from '../src/boss.ts';
import { CHAT_MESSAGE_MAX_CHARS, type AppState } from '../src/contracts.ts';
import { instantReadClock, tempDir, api } from './helpers.ts';
import { startMockModel, mockProviderToml } from './mock-responses.ts';

test('多方向结果超过单条消息上限时分条写回，不截断后续方向统计', async () => {
  const directions = Array.from({ length: 20 }, (_, i) => ({ name: '方向'.repeat(38) + i, keywords: [`Python${i}`], count: 1 }));
  const message = '深圳，薪资不限，按上述20个方向各找1个，先存草稿';
  const mock = await startMockModel([
    [{ type: 'function_call', name: 'start_delivery', args: { city: '深圳', salaryMinK: null, criteria: 'Python', sendNow: false, quote: message, directions } }],
    [{ type: 'message', text: '完成' }],
  ]);
  const dir = tempDir('boss-reporting-');
  fs.mkdirSync(path.join(dir, 'codex-home'));
  fs.writeFileSync(path.join(dir, 'codex-home', 'config.toml'), mockProviderToml(mock.baseUrl, 'gpt-mock'));
  const forbidden = async (): Promise<never> => { throw new Error('无候选时不应有详情或联系动作'); };
  const site: Site = {
    open: async () => ({ page: 'ready', url: null }), status: async () => ({ page: 'ready', url: null }), close: async () => {}, search: async () => [],
    jobDetail: forbidden, openJob: forbidden, contact: forbidden, readChat: forbidden, sendGreeting: forbidden,
  };
  const server = await startServer({ readClock: instantReadClock, dataDir: dir, port: 0, site });
  try {
    await api(server.url, 'PUT', '/api/inputs', { requirements: '', resume: { text: 'Python经验' } });
    await api(server.url, 'POST', '/api/chat', { message });
    const state = await new Promise<AppState>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); server.app.off('changed', check); };
      const check = () => void server.app.getState().then(s => { if (!s.chat.pending && s.discovery.status === 'idle') { cleanup(); resolve(s); } }, e => { cleanup(); reject(e); });
      const timer = setTimeout(() => { cleanup(); reject(new Error('任务未结束')); }, 10_000);
      server.app.on('changed', check); check();
    });
    assert.ok(state.discovery.message!.length > CHAT_MESSAGE_MAX_CHARS);
    const messages = state.chat.messages.filter(m => m.role === 'assistant').map(m => m.text);
    assert.ok(messages.every(text => text.length <= CHAT_MESSAGE_MAX_CHARS));
    assert.ok(messages.some((_, i) => messages.slice(i).join('\n') === state.discovery.message), '最终对话消息序列须完整保留全部方向报告');
  } finally { await server.close(); mock.close(); }
});
