import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Browser } from '../src/browser.ts';
import { createBossSite } from '../src/boss.ts';
import { tempDir } from './helpers.ts';

// 用户关掉浏览器窗口后，agent-browser 的下一条命令会自建空白页；空白页即视为浏览器已关闭，不能当作已登录。
test('浏览器停在空白页时视为已关闭并收起空白窗口', async () => {
  const browser = new Browser({ profileDir: path.join(tempDir('boss-blank-'), 'profile'), headed: false, namespace: `blank-${process.pid}` });
  try {
    await browser.open('about:blank');
    assert.equal((await createBossSite(browser).status()).page, 'closed');
    assert.equal(browser.isOpen, false);
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

test('岗位卡薪资的站点混淆数字被还原', async () => {
  const dir = tempDir('boss-salary-');
  const page = path.join(dir, 'page.html');
  fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><div class="nav-figure">求职者</div><ul><li><a href="https://www.zhipin.com/job_detail/j1.html"><span class="job-name">Agent开发</span></a><span class="job-salary">\ue035\ue031-\ue037\ue031K·\ue032\ue034薪</span></li></ul>');
  const browser = new Browser({ profileDir: path.join(dir, 'profile'), headed: false, namespace: `salary-${process.pid}` });
  // 只替代来源域与导航目标；岗位卡提取仍由真实 CloakBrowser 执行生产脚本。
  const site = createBossSite({ get isOpen() { return browser.isOpen; }, open: () => browser.open(pathToFileURL(page).href), waitFor: async () => {},
    async eval(expression: string) {
      const observed = await browser.eval<unknown>(expression);
      return Array.isArray(observed) ? observed : { ...(observed as object), url: 'https://www.zhipin.com/web/geek/jobs' };
    } } as unknown as Browser);
  try {
    await browser.open('about:blank');
    assert.equal((await site.search({ keyword: 'Agent', city: '北京', page: 1 }))[0]?.salary, '40-60K·13薪');
  } finally { await browser.close(); }
});

for (const [name, home, expected] of [
  ['已登录时打开浏览器直接报告已登录，不停在登录页跳转中途', { hasAccount: true, loginLink: false }, { page: 'ready', url: 'https://www.zhipin.com/' }],
  ['未登录时打开浏览器进入登录页', { hasAccount: false, loginLink: true }, { page: 'loggedOut', url: 'https://www.zhipin.com/web/user/' }],
] as const) {
  test(name, async () => {
    let url = 'about:blank';
    // 已登录账号访问登录页会在加载后再跳回首页；探针在跳转前读取只会看到登录页。
    const site = createBossSite({ isOpen: true, async open(next: string) { url = next; }, async waitFor() {},
      async eval() { return url.endsWith('/web/user/') ? { url, title: '登录', hasAccount: false, loginLink: false } : { url, title: 'BOSS直聘', ...home }; },
    } as unknown as Browser);
    assert.deepEqual(await site.open(), expected);
  });
}

test('搜索等岗位列表异步渲染后再提取，不把加载中当作没有结果', async () => {
  const dir = tempDir('boss-async-list-');
  const page = path.join(dir, 'page.html');
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><div class="nav-figure">求职者</div><ul id="list"></ul><script>
    setTimeout(() => { document.getElementById('list').innerHTML = '<li class="job-card-box"><a href="https://www.zhipin.com/job_detail/j1.html"><span class="job-name">Agent开发</span></a></li>'; }, 800);
  </script>`);
  const browser = new Browser({ profileDir: path.join(dir, 'profile'), headed: false, namespace: `async-list-${process.pid}` });
  // 本地文件不是 BOSS 来源：只跳过来源域等待，其余等待与提取由真实 CloakBrowser 执行。
  const site = createBossSite({ get isOpen() { return browser.isOpen; }, open: () => browser.open(pathToFileURL(page).href),
    waitFor: (expression: string) => expression.includes('location.origin') ? Promise.resolve() : browser.waitFor(expression),
    async eval(expression: string) {
      const observed = await browser.eval<unknown>(expression);
      return Array.isArray(observed) ? observed : { ...(observed as object), url: 'https://www.zhipin.com/web/geek/jobs' };
    } } as unknown as Browser);
  try {
    await browser.open('about:blank');
    assert.deepEqual((await site.search({ keyword: 'Agent', city: '深圳', page: 1 })).map((c) => c.jobId), ['j1']);
  } finally { await browser.close(); }
});
