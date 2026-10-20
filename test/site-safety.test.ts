import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
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

for (const [name, html, expected] of [
  ['可见账号与隐藏登录按钮表示已登录', '<div class="nav-figure">求职者</div><button hidden>登录</button><button style="display:none">登录/注册</button>', 'ready'],
  ['隐藏账号不能覆盖可见登录提示', '<div class="nav-figure" hidden>求职者</div><button>登录</button>', 'loggedOut'],
  ['账号与登录均不可见时不猜登录状态', '<div class="nav-figure" style="visibility:hidden">求职者</div><button hidden>登录</button>', 'unknown'],
] as const) {
  test(name, async () => {
    const dir = tempDir('boss-login-');
    const page = path.join(dir, 'page.html');
    fs.writeFileSync(page, '<!doctype html><title>首页</title>' + html);
    const browser = new Browser({ profileDir: path.join(dir, 'profile'), headed: false, namespace: `login-${process.pid}` });
    // 只替代来源域；账号/登录可见性仍由真实 CloakBrowser 执行生产探针判断。
    const site = createBossSite({ get isOpen() { return browser.isOpen; }, async eval(expression: string) {
      const observed = await browser.eval<Record<string, unknown>>(expression);
      return { ...observed, url: 'https://www.zhipin.com/' };
    } } as Browser);
    try {
      await browser.open(pathToFileURL(page).href);
      assert.equal((await site.status()).page, expected);
    } finally { await browser.close(); }
  });
}
