import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { App } from '../src/app.ts';
import { tempDir } from './helpers.ts';
import { mockProviderToml } from './mock-responses.ts';
import type { AppState } from '../src/contracts.ts';

test('真实 Codex 收到模型失败事件后记录错误终态及完成时间', async () => {
  const provider = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response: { id: 'failure', error: { code: 'invalid_prompt', message: 'fixture rejected input' } } })}\n\n`);
    });
  });
  await new Promise<void>(r => provider.listen(0, '127.0.0.1', r));
  const dir = tempDir('boss-provider-failure-');
  fs.mkdirSync(path.join(dir, 'codex-home'));
  fs.writeFileSync(path.join(dir, 'codex-home', 'config.toml'), mockProviderToml(`http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`, 'gpt-mock'));
  const app = new App({ dataDir: dir });
  try {
    app.saveInputs({ requirements: '北京前端，薪资不限', resume: { text: '简历' } });
    await app.startDiscovery();
    const finished = await new Promise<AppState>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); app.off('changed', check); };
      const check = () => void app.getState().then(s => {
        if (s.discovery.status === 'idle') { cleanup(); resolve(s); }
      }, e => { cleanup(); reject(e); });
      const timer = setTimeout(() => { cleanup(); reject(new Error('模型错误后未结束')); }, 10_000);
      app.on('changed', check);
      check();
    });
    assert.match(finished.discovery.message!, /fixture rejected input/);
    assert.ok(finished.discovery.startedAt);
    assert.ok(finished.discovery.finishedAt);
    assert.ok(Date.parse(finished.discovery.finishedAt) >= Date.parse(finished.discovery.startedAt));
  } finally {
    await app.close();
    await new Promise<void>(r => provider.close(() => r()));
  }
});
