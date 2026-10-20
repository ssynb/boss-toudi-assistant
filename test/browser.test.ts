import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Browser } from '../src/browser.ts';
import { tempDir } from './helpers.ts';

test('用真实 CloakBrowser 与 agent-browser 在独立 profile 完成快照、填入和点击', async () => {
  const dir = tempDir('boss-browser-');
  const page = path.join(dir, 'page.html');
  fs.writeFileSync(page, '<!doctype html><title>本地测试页</title><input aria-label="内容"><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">记录</button><output></output>');
  const browser = new Browser({ profileDir: path.join(dir, 'profile'), headed: false, namespace: `test-${process.pid}` });
  try {
    await browser.open('chrome://version');
    const executable = await browser.eval<string>("document.querySelector('#executable_path').textContent");
    assert.match(executable, /cloakbrowser[\\/]chromium-[0-9.]+[\\/]/, '实际运行的是官方 CloakBrowser 缓存中的二进制，不是 Chrome');
    const command = await browser.eval<string>("document.querySelector('#command_line').textContent");
    assert.match(command, /--fingerprint=/);
    await browser.open(pathToFileURL(page).href);
    assert.equal(await browser.eval<string>('document.title'), '本地测试页');
    const snap = await browser.snapshot();
    const input = Object.entries(snap.refs).find(([, r]) => r.role === 'textbox' && r.name === '内容')?.[0];
    const button = Object.entries(snap.refs).find(([, r]) => r.role === 'button' && r.name === '记录')?.[0];
    assert.ok(input);
    assert.ok(button);
    await browser.fill(input, '仅本地验收');
    await browser.click(button);
    assert.equal(await browser.eval<string>("document.querySelector('output').textContent"), '仅本地验收');
  } finally {
    await browser.close();
  }
});

test('按序号点击和容器内双向滚动只作用于指定元素', async () => {
  const dir = tempDir('boss-browser-actions-');
  const page = path.join(dir, 'page.html');
  fs.writeFileSync(page, `<!doctype html><button onclick="document.querySelector('output').textContent='first'">第一项</button><button onclick="document.querySelector('output').textContent='second'">第二项</button><output></output><div id="list" style="height:100px;overflow:auto"><div style="height:1000px">内容</div></div>`);
  const browser = new Browser({ profileDir: path.join(dir, 'profile'), headed: false, namespace: `actions-${process.pid}` });
  try {
    await browser.open(pathToFileURL(page).href);
    await browser.clickNth('button', 1);
    assert.equal(await browser.eval("document.querySelector('output').textContent"), 'second');
    await browser.scrollWithin('#list', 'down', 200);
    await browser.waitFor("document.querySelector('#list').scrollTop > 0");
    await browser.scrollWithin('#list', 'up', 1000);
    await browser.waitFor("document.querySelector('#list').scrollTop === 0");
    assert.equal(await browser.eval('window.scrollY'), 0);
  } finally { await browser.close(); }
});
