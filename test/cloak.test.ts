import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { requireCloakPlatform } from '../src/cloak.ts';
import { tempDir } from './helpers.ts';

const moduleUrl = pathToFileURL(path.resolve('src/cloak.ts')).href;

test('平台支持明确：macOS 双架构、Windows x64；Windows arm64 不偷换浏览器', () => {
  for (const [platform, arch] of [['darwin','x64'], ['darwin','arm64'], ['win32','x64']]) assert.doesNotThrow(() => requireCloakPlatform(platform!, arch!));
  assert.throws(() => requireCloakPlatform('win32', 'arm64'), /不支持.*win32.*arm64/);
});

test('Cloak 缺失时拒绝普通浏览器覆盖，doctor 不报告 Chrome 可用', () => {
  const home = tempDir('boss-no-cloak-');
  const code = `import {resolveCloak} from ${JSON.stringify(moduleUrl)};
    import {runDoctor} from ${JSON.stringify(pathToFileURL(path.resolve('src/doctor.ts')).href)};
    try { await resolveCloak(${JSON.stringify(path.join(home, 'app', 'cloakbrowser'))}); process.exit(7); }
    catch(e) { console.log(e.message); }
    console.log(JSON.stringify((await runDoctor(${JSON.stringify(path.join(home, 'app'))})).find(x=>x.id==='browser')));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: {
    ...process.env, HOME: home, USERPROFILE: home,
    BOSS_BROWSER_PATH: process.execPath, CLOAKBROWSER_BINARY_PATH: process.execPath,
    CLOAKBROWSER_LICENSE_KEY: 'must-not-use',
  } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /CloakBrowser.*未安装/);
  assert.equal(JSON.parse(run.stdout.trim().split('\n').at(-1)!).ok, false);
});

test('没有用户单独许可确认时安装立即拒绝，不创建下载目录', () => {
  const home = tempDir('boss-cloak-consent-');
  const cache = path.join(home, 'cache');
  const code = `import {installCloak} from ${JSON.stringify(moduleUrl)}; await installCloak(${JSON.stringify(cache)});`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, BOSS_CLOAK_LICENSE_ACCEPTED: '' } });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /许可/);
  assert.ok(!fs.existsSync(cache));
});
