import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Browser } from '../src/browser.ts';
import { createBossSite } from '../src/boss.ts';
import { tempDir } from './helpers.ts';

test('浏览器停在空白页不能当作 BOSS 已登录', async () => {
  const browser = new Browser({ profileDir: path.join(tempDir('boss-blank-'), 'profile'), headed: false, namespace: `blank-${process.pid}` });
  try {
    await browser.open('about:blank');
    assert.equal((await createBossSite(browser).status()).page, 'unknown');
  } finally {
    await browser.close();
  }
});
