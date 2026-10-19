/** 在隔离环境中调用官方 wrapper；不加载用户的 Cloak 配置、版本覆盖或个人许可证。 */
import fs from 'node:fs';
import path from 'node:path';
import { binaryInfo, ensureBinary, getDefaultStealthArgs } from 'cloakbrowser';

const cache = process.env.CLOAKBROWSER_CACHE_DIR;
if (!cache) throw new Error('缺少应用专用 CloakBrowser 缓存目录');
if (fs.existsSync(path.join(cache, 'license.key'))) {
  throw new Error('本应用仅接入无 key 免费版，不读取缓存中的 license.key；订阅版需另行确认接入');
}
const info = binaryInfo();
if (info.tier !== 'free') throw new Error('不自动使用订阅版或降级；请用户核对 CloakBrowser 安装与许可');
if (!/^\d+(?:\.\d+){3,4}$/.test(info.version)) throw new Error('CloakBrowser 缓存版本无效');
if (process.argv[2] === 'install') {
  if (process.env.BOSS_CLOAK_LICENSE_ACCEPTED !== '1.3') throw new Error('需要用户本人确认 CloakBrowser Binary License v1.3，未开始下载');
  await ensureBinary(undefined, info.version);
}
const resolved = binaryInfo(info.version);
if (resolved.tier !== 'free') throw new Error('拒绝使用订阅版缓存，需要用户另行确认许可与接入');
console.log(JSON.stringify({ ...resolved, args: getDefaultStealthArgs() }));
