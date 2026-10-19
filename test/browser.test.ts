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
