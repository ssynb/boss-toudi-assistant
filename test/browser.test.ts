import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Browser } from '../src/browser.ts';
import { tempDir } from './helpers.ts';

test('在本机系统上用独立 profile 驱动真实浏览器读取页面', async () => {
  const dir = tempDir('boss-browser-');
  const page = path.join(dir, 'page.html');
  fs.writeFileSync(page, '<!doctype html><title>本地测试页</title><button>立即沟通</button>');
  const browser = new Browser({ profileDir: path.join(dir, 'profile'), headed: false, namespace: `test-${process.pid}` });
  try {
    await browser.open(pathToFileURL(page).href);
    assert.equal(await browser.eval<string>('document.title'), '本地测试页');
    const snap = await browser.snapshot();
    assert.ok(Object.values(snap.refs).some((r) => r.role === 'button' && r.name === '立即沟通'));
  } finally {
    await browser.close();
  }
});
