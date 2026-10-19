import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveCloak } from '../src/cloak.ts';
import { tempDir } from './helpers.ts';

test('专用缓存出现个人 key 时明确阻塞，不读取或回退', async () => {
  const cache = tempDir('boss-cloak-key-');
  fs.writeFileSync(path.join(cache, 'license.key'), 'synthetic-not-a-license');
  await assert.rejects(resolveCloak(cache), /不读取.*license.key/);
});

test('无版本标记的订阅版缓存也不能被当成免费版运行', async () => {
  const cache = tempDir('boss-cloak-pro-');
  const version = process.platform === 'darwin' ? '145.0.7632.109.2' : process.arch === 'arm64' ? '146.0.7680.177.3' : '146.0.7680.177.5';
  const executable = process.platform === 'darwin' ? 'Chromium.app/Contents/MacOS/Chromium' : process.platform === 'win32' ? 'chrome.exe' : 'chrome';
  const file = path.join(cache, `chromium-${version}-pro`, executable);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not-a-browser', { mode: 0o755 });
  await assert.rejects(resolveCloak(cache), /订阅版/);
});
